// tests/finn/jwt-roundtrip.test.ts — JWT E2E Roundtrip (Task 2.10, A.8)
// ES256 sign → validate → extract claims against loa-hounfour schemas.

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { generateKeyPair, SignJWT, exportJWK } from "jose"
import { Hono } from "hono"
import { serve } from "@hono/node-server"
import type { Server } from "node:http"
import {
  validateJWT,
  isStructurallyJWT,
  namespaceJti,
  resolveAudience,
  isJtiRequired,
  JWKSStateMachine,
  resetJWKSCache,
  sha256Hex,
  type JWTClaims,
  type JWTConfig,
} from "../../src/hounfour/jwt-auth.js"
import {
  resolveAndAuthorize,
  getDefaultPool,
  getAccessiblePools,
  assertValidPoolId,
  type PoolId,
  type Tier,
} from "../../src/hounfour/tier-bridge.js"
import { deriveIdempotencyKey } from "@0xhoneyjar/loa-hounfour"

// --- ES256 Keypair & JWKS Server ---

let privateKey: CryptoKey
let publicJwk: Record<string, unknown>
let jwksServer: Server | null = null
let jwksUrl: string
const KID = "test-key-001"

async function signTestJWT(
  claims: Partial<JWTClaims> & { iss: string; aud: string },
  opts?: { kid?: string; expiresIn?: string },
): Promise<string> {
  return new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: opts?.kid ?? KID })
    .setIssuedAt()
    .setExpirationTime(opts?.expiresIn ?? "5m")
    .sign(privateKey)
}

function makeFullClaims(overrides: Partial<JWTClaims> = {}): JWTClaims {
  const body = JSON.stringify({ prompt: "hello world", model: "gpt-4o" })
  const reqHash = `sha256:${sha256Hex(new TextEncoder().encode(body))}`
  return {
    iss: "arrakis",
    aud: "loa-finn",
    sub: "user-1",
    tenant_id: "tenant-abc",
    tier: "pro",
    req_hash: reqHash,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: `jti-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  }
}

const jwtConfig: JWTConfig = {
  enabled: true,
  issuer: "arrakis",
  issuers: ["arrakis"],
  audience: "loa-finn",
  jwksUrl: "", // set in beforeAll
  clockSkewSeconds: 5,
  maxTokenLifetimeSeconds: 600,
}

beforeAll(async () => {
  // Generate ES256 keypair
  const { privateKey: priv, publicKey } = await generateKeyPair("ES256")
  privateKey = priv
  const jwk = await exportJWK(publicKey)
  publicJwk = { ...jwk, kid: KID, alg: "ES256", use: "sig" }

  // Start minimal JWKS server
  const app = new Hono()
  app.get("/.well-known/jwks.json", (c) => {
    return c.json({ keys: [publicJwk] })
  })

  await new Promise<void>((resolve) => {
    jwksServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
      jwksUrl = `http://localhost:${info.port}/.well-known/jwks.json`
      jwtConfig.jwksUrl = jwksUrl
      resolve()
    })
  })
})

afterAll(async () => {
  if (jwksServer) jwksServer.close()
  resetJWKSCache()
})

// --- Tests ---

describe("ES256 sign → validate roundtrip", () => {
  it("signs and validates a complete JWT with all claims", async () => {
    resetJWKSCache()
    const claims = makeFullClaims()
    const token = await signTestJWT(claims)

    const result = await validateJWT(token, jwtConfig)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.claims.tenant_id).toBe("tenant-abc")
    expect(result.claims.tier).toBe("pro")
    expect(result.claims.iss).toBe("arrakis")
    expect(result.claims.aud).toBe("loa-finn")
    expect(result.claims.req_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("validates all three tiers", async () => {
    for (const tier of ["free", "pro", "enterprise"] as const) {
      resetJWKSCache()
      const claims = makeFullClaims({ tier })
      const token = await signTestJWT(claims)
      const result = await validateJWT(token, jwtConfig)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.claims.tier).toBe(tier)
    }
  })

  it("rejects expired tokens", async () => {
    resetJWKSCache()
    // Sign a token that expired 30s ago (well beyond clockSkewSeconds=5)
    const claims = makeFullClaims({
      exp: Math.floor(Date.now() / 1000) - 30,
    })
    const token = await new SignJWT(claims as unknown as Record<string, unknown>)
      .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: KID })
      .sign(privateKey)

    const result = await validateJWT(token, jwtConfig)
    expect(result.ok).toBe(false)
  })

  it("rejects wrong issuer", async () => {
    resetJWKSCache()
    const claims = makeFullClaims({ iss: "evil-service" })
    const token = await signTestJWT(claims)

    const result = await validateJWT(token, jwtConfig)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("ISSUER_NOT_ALLOWED")
  })

  it("rejects wrong audience", async () => {
    resetJWKSCache()
    const claims = makeFullClaims({ aud: "wrong-service" })
    const token = await signTestJWT(claims)

    const result = await validateJWT(token, jwtConfig)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("AUDIENCE_MISMATCH")
  })

  it("rejects structurally invalid tokens", () => {
    expect(isStructurallyJWT("not-a-jwt")).toBe(false)
    expect(isStructurallyJWT("only.two")).toBe(false)
    expect(isStructurallyJWT("")).toBe(false)
  })

  it("validates NFT-routed claims", async () => {
    resetJWKSCache()
    const claims = makeFullClaims({
      nft_id: "nft-0x1234",
      model_preferences: { chat: "openai:gpt-4o", code: "anthropic:claude-opus-4-6" },
    })
    const token = await signTestJWT(claims)

    const result = await validateJWT(token, jwtConfig)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.claims.nft_id).toBe("nft-0x1234")
      expect(result.claims.model_preferences).toEqual({
        chat: "openai:gpt-4o",
        code: "anthropic:claude-opus-4-6",
      })
    }
  })

  it("validates BYOK claims", async () => {
    resetJWKSCache()
    const claims = makeFullClaims({ byok: true })
    const token = await signTestJWT(claims)

    const result = await validateJWT(token, jwtConfig)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.claims.byok).toBe(true)
  })
})

describe("JWT → tier-bridge → pool resolution", () => {
  it("extracts tier from JWT and resolves to correct pool", async () => {
    resetJWKSCache()
    const claims = makeFullClaims({ tier: "free" })
    const token = await signTestJWT(claims)

    const result = await validateJWT(token, jwtConfig)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")

    const pool = resolveAndAuthorize(result.claims.tier as Tier)
    const defaultPool = getDefaultPool("free")
    expect(pool).toBe(defaultPool)
    assertValidPoolId(pool)
  })

  it("resolves all tiers to valid pools", async () => {
    for (const tier of ["free", "pro", "enterprise"] as const) {
      const pool = getDefaultPool(tier)
      assertValidPoolId(pool)
      const pools = getAccessiblePools(tier)
      expect(pools.length).toBeGreaterThan(0)
      expect(pools).toContain(pool)
    }
  })

  it("NFT preferences resolve to valid pools", async () => {
    resetJWKSCache()
    const claims = makeFullClaims({
      tier: "enterprise",
      nft_id: "nft-0x999",
      model_preferences: { chat: "openai:gpt-4o" },
    })
    const token = await signTestJWT(claims)

    const result = await validateJWT(token, jwtConfig)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")

    // Enterprise tier can access gpt-4o pool
    const pool = resolveAndAuthorize(
      result.claims.tier as Tier,
      "chat",
      result.claims.model_preferences,
    )
    assertValidPoolId(pool)
  })
})

describe("JWT → idempotency key derivation", () => {
  it("derives deterministic idempotency key from JWT claims", async () => {
    resetJWKSCache()
    const claims = makeFullClaims()
    const token = await signTestJWT(claims)

    const result = await validateJWT(token, jwtConfig)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")

    const key = deriveIdempotencyKey(
      result.claims.tenant_id,
      result.claims.req_hash,
      "openai",
      "gpt-4o",
    )

    // Key should be hex SHA256 (64 chars)
    expect(key).toMatch(/^[0-9a-f]{64}$/)

    // Same inputs → same key (deterministic)
    const key2 = deriveIdempotencyKey(
      result.claims.tenant_id,
      result.claims.req_hash,
      "openai",
      "gpt-4o",
    )
    expect(key2).toBe(key)

    // Different model → different key
    const key3 = deriveIdempotencyKey(
      result.claims.tenant_id,
      result.claims.req_hash,
      "anthropic",
      "claude-opus-4-6",
    )
    expect(key3).not.toBe(key)
  })
})

describe("JTI policy enforcement", () => {
  it("requires JTI for invoke endpoints", () => {
    expect(isJtiRequired("invoke")).toBe(true)
  })

  it("requires JTI for admin endpoints", () => {
    expect(isJtiRequired("admin")).toBe(true)
  })

  it("does not require JTI for s2s GET endpoints", () => {
    expect(isJtiRequired("s2s")).toBe(false)
  })

  it("rejects invoke request without JTI", async () => {
    resetJWKSCache()
    const claims = makeFullClaims()
    delete (claims as Partial<JWTClaims>).jti
    const token = await signTestJWT(claims)

    const result = await validateJWT(token, jwtConfig, undefined, {
      endpointType: "invoke",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("JTI_REQUIRED")
  })

  it("namespaces JTI with issuer to prevent cross-issuer collision", () => {
    const ns1 = namespaceJti("arrakis", "jti-123")
    const ns2 = namespaceJti("evil", "jti-123")
    expect(ns1).not.toBe(ns2)
    expect(ns1).toBe("jti:arrakis:jti-123")
  })
})

describe("audience resolution", () => {
  it("resolves correct audiences for endpoint types", () => {
    expect(resolveAudience("invoke")).toBe("loa-finn")
    expect(resolveAudience("admin")).toBe("loa-finn-admin")
    expect(resolveAudience("s2s")).toBe("arrakis")
  })
})

describe("JWKS state machine integration", () => {
  it("transitions through HEALTHY → STALE → DEGRADED", async () => {
    const machine = new JWKSStateMachine(jwksUrl)

    // Initially DEGRADED (never validated)
    expect(machine.state).toBe("DEGRADED")
    expect(machine.initialized).toBe(false)

    // Record a success
    machine.recordSuccess(KID)
    expect(machine.state).toBe("HEALTHY")
    expect(machine.initialized).toBe(true)
    expect(machine.isKnownKid(KID)).toBe(true)

    // Fast-forward past HEALTHY TTL (15min)
    machine._setLastSuccessMs(Date.now() - 16 * 60 * 1000)
    expect(machine.state).toBe("STALE")

    // Fast-forward past max staleness (24h)
    machine._setLastSuccessMs(Date.now() - 25 * 60 * 60 * 1000)
    expect(machine.state).toBe("DEGRADED")
  })

  it("invalidation resets all state", async () => {
    const machine = new JWKSStateMachine(jwksUrl)
    machine.recordSuccess(KID)
    expect(machine.isKnownKid(KID)).toBe(true)

    machine.invalidate()
    expect(machine.isKnownKid(KID)).toBe(false)
    expect(machine.initialized).toBe(false)
    expect(machine.state).toBe("DEGRADED")
  })
})

describe("req_hash verification roundtrip", () => {
  it("req_hash from JWT matches body hash", () => {
    const body = JSON.stringify({ prompt: "hello world", model: "gpt-4o" })
    const hash = sha256Hex(new TextEncoder().encode(body))
    const reqHash = `sha256:${hash}`

    // Verify format
    expect(reqHash).toMatch(/^sha256:[0-9a-f]{64}$/)

    // Same body → same hash
    const hash2 = sha256Hex(new TextEncoder().encode(body))
    expect(hash2).toBe(hash)

    // Different body → different hash
    const differentBody = JSON.stringify({ prompt: "goodbye", model: "gpt-4o" })
    const hash3 = sha256Hex(new TextEncoder().encode(differentBody))
    expect(hash3).not.toBe(hash)
  })
})

describe("multi-issuer allowlist roundtrip", () => {
  it("accepts tokens from multiple allowed issuers", async () => {
    const multiIssuerConfig: JWTConfig = {
      ...jwtConfig,
      issuers: ["arrakis", "arrakis-staging"],
    }

    for (const iss of ["arrakis", "arrakis-staging"]) {
      resetJWKSCache()
      const claims = makeFullClaims({ iss })
      const token = await signTestJWT(claims)
      const result = await validateJWT(token, multiIssuerConfig)
      expect(result.ok).toBe(true)
    }
  })

  it("rejects tokens from unlisted issuers", async () => {
    const multiIssuerConfig: JWTConfig = {
      ...jwtConfig,
      issuers: ["arrakis", "arrakis-staging"],
    }

    resetJWKSCache()
    const claims = makeFullClaims({ iss: "unknown-service" })
    const token = await signTestJWT(claims)
    const result = await validateJWT(token, multiIssuerConfig)
    expect(result.ok).toBe(false)
  })
})
