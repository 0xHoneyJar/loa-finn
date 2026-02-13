// tests/finn/jwt-auth.test.ts — JWT Validation Middleware tests (T-A.1)
// Phase 5 Sprint 2: JWKS state machine, issuer allowlist, jti namespace, audience rules.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Hono } from "hono"
import { generateKeyPair, exportJWK, SignJWT } from "jose"
import { serve } from "@hono/node-server"
import {
  jwtAuthMiddleware,
  validateJWT,
  validateWsJWT,
  isStructurallyJWT,
  resetJWKSCache,
  JWKSStateMachine,
  namespaceJti,
  isJtiRequired,
  resolveAudience,
  jwksInvalidateHandler,
  getJWKSStateMachine,
  JTI_POLICY,
  AUDIENCE_MAP,
} from "../../src/hounfour/jwt-auth.js"
import type { JWTConfig, EndpointType, ValidateJWTOptions } from "../../src/hounfour/jwt-auth.js"
import type { FinnConfig } from "../../src/config.js"
import { InMemoryJtiReplayGuard } from "../../src/hounfour/jti-replay.js"

// --- Golden Vectors ---

const VECTORS_DIR = resolve(import.meta.dirname ?? ".", "../../packages/loa-hounfour/vectors/jwt")
const conformanceVectors = JSON.parse(readFileSync(resolve(VECTORS_DIR, "conformance.json"), "utf-8"))

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

function getJWTConfig(overrides?: Partial<JWTConfig>): JWTConfig {
  return {
    enabled: true,
    issuer: "arrakis",
    audience: "loa-finn",
    jwksUrl: `http://localhost:${jwksPort}/.well-known/jwks.json`,
    clockSkewSeconds: 30,
    maxTokenLifetimeSeconds: 3600,
    ...overrides,
  }
}

async function signJWT(
  claims: Record<string, unknown>,
  options?: { kid?: string; privateKey?: CryptoKey; noTyp?: boolean },
): Promise<string> {
  const key = options?.privateKey ?? currentKeyPair.privateKey
  const kid = options?.kid ?? "key-current"

  const headerParams: Record<string, unknown> = { alg: "ES256", kid }
  if (!options?.noTyp) {
    headerParams.typ = "JWT"
  }

  const builder = new SignJWT(claims as Record<string, unknown>)
    .setProtectedHeader(headerParams as { alg: string; kid: string; typ?: string })
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
    jti: "unique-request-id-001",
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

  // =========================================================================
  // Structural Pre-Check
  // =========================================================================

  describe("isStructurallyJWT", () => {
    it("returns true for valid JWT structure (ES256 + kid)", async () => {
      const token = await signJWT(validClaims())
      expect(isStructurallyJWT(token)).toBe(true)
    })

    it("returns true without typ header (kid present)", async () => {
      const token = await signJWT(validClaims(), { noTyp: true })
      expect(isStructurallyJWT(token)).toBe(true)
    })

    it("returns false for opaque bearer token", () => {
      expect(isStructurallyJWT("some-opaque-bearer-token")).toBe(false)
    })

    it("returns false for two-segment token", () => {
      expect(isStructurallyJWT("abc.def")).toBe(false)
    })

    it("returns false for non-ES256 JWT header", () => {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" })).toString("base64url")
      const payload = Buffer.from("{}").toString("base64url")
      expect(isStructurallyJWT(`${header}.${payload}.fakesig`)).toBe(false)
    })

    it("returns false for missing kid in header", () => {
      const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url")
      const payload = Buffer.from("{}").toString("base64url")
      expect(isStructurallyJWT(`${header}.${payload}.fakesig`)).toBe(false)
    })

    it("returns false for empty kid in header", () => {
      const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "" })).toString("base64url")
      const payload = Buffer.from("{}").toString("base64url")
      expect(isStructurallyJWT(`${header}.${payload}.fakesig`)).toBe(false)
    })
  })

  // =========================================================================
  // Core JWT Validation
  // =========================================================================

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
      const token = await new SignJWT(validClaims() as Record<string, unknown>)
        .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "key-current" })
        .setIssuedAt(Math.floor(Date.now() / 1000) + 25)
        .setExpirationTime("1h")
        .sign(currentKeyPair.privateKey)

      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(true)
    })

    it("handles dual-key rotation window", async () => {
      previousKeyPair = currentKeyPair
      currentKeyPair = await generateKeyPair("ES256")

      const token = await signJWT(validClaims(), {
        kid: "key-previous",
        privateKey: previousKeyPair.privateKey,
      })

      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(true)

      previousKeyPair = null
    })

    it("refetches JWKS on kid cache miss via new kid", async () => {
      const newKeyPair = await generateKeyPair("ES256")

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
        const config = getJWTConfig({
          jwksUrl: `http://localhost:${rotatedServer.port}/.well-known/jwks.json`,
        })

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

  // =========================================================================
  // Issuer Allowlist
  // =========================================================================

  describe("issuer allowlist", () => {
    it("accepts token from single issuer (legacy config)", async () => {
      const token = await signJWT(validClaims())
      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(true)
    })

    it("accepts token from allowlisted issuer (multi-issuer config)", async () => {
      const config = getJWTConfig({
        issuers: ["arrakis", "https://auth.honeyjar.xyz"],
      })
      const token = await signJWT(validClaims())
      const result = await validateJWT(token, config)
      expect(result.ok).toBe(true)
    })

    it("accepts token from second allowlisted issuer", async () => {
      const config = getJWTConfig({
        issuers: ["https://auth.honeyjar.xyz", "arrakis"],
      })
      const token = await signJWT(validClaims())
      const result = await validateJWT(token, config)
      expect(result.ok).toBe(true)
    })

    it("rejects token from non-allowlisted issuer", async () => {
      const config = getJWTConfig({
        issuers: ["https://auth.honeyjar.xyz"],
      })
      const token = await signJWT({ ...validClaims(), iss: "arrakis" })
      const result = await validateJWT(token, config)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("ISSUER_NOT_ALLOWED")
      }
    })

    it("uses exact string match (no substring matching)", async () => {
      const config = getJWTConfig({
        issuers: ["arrakis-prod"],
      })
      const token = await signJWT({ ...validClaims(), iss: "arrakis" })
      const result = await validateJWT(token, config)
      expect(result.ok).toBe(false)
    })
  })

  // =========================================================================
  // JTI Requirement Matrix
  // =========================================================================

  describe("jti requirement matrix", () => {
    it("requires jti for invoke endpoints", () => {
      expect(isJtiRequired("invoke")).toBe(true)
    })

    it("requires jti for admin endpoints", () => {
      expect(isJtiRequired("admin")).toBe(true)
    })

    it("does not require jti for s2s endpoints", () => {
      expect(isJtiRequired("s2s")).toBe(false)
    })

    it("rejects invoke token without jti", async () => {
      const claims = validClaims()
      delete claims.jti
      const token = await signJWT(claims)
      const result = await validateJWT(token, getJWTConfig(), undefined, { endpointType: "invoke" })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("JTI_REQUIRED")
      }
    })

    it("rejects admin token without jti", async () => {
      const claims = { ...validClaims(), aud: "loa-finn-admin" }
      delete claims.jti
      const token = await signJWT(claims)
      const config = getJWTConfig()
      const result = await validateJWT(token, config, undefined, { endpointType: "admin" })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("JTI_REQUIRED")
      }
    })

    it("accepts s2s token without jti (short exp compensates)", async () => {
      const claims = { ...validClaims(), aud: "arrakis" }
      delete claims.jti
      const token = await signJWT(claims)
      const config = getJWTConfig()
      const result = await validateJWT(token, config, undefined, { endpointType: "s2s" })
      expect(result.ok).toBe(true)
    })
  })

  // =========================================================================
  // Audience Rules
  // =========================================================================

  describe("audience rules", () => {
    it("resolves invoke audience to loa-finn", () => {
      expect(resolveAudience("invoke")).toBe("loa-finn")
    })

    it("resolves admin audience to loa-finn-admin", () => {
      expect(resolveAudience("admin")).toBe("loa-finn-admin")
    })

    it("resolves s2s audience to arrakis", () => {
      expect(resolveAudience("s2s")).toBe("arrakis")
    })

    it("rejects invoke token with admin audience", async () => {
      const token = await signJWT({ ...validClaims(), aud: "loa-finn-admin" })
      const result = await validateJWT(token, getJWTConfig(), undefined, { endpointType: "invoke" })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("AUDIENCE_MISMATCH")
      }
    })

    it("accepts admin token with admin audience", async () => {
      const token = await signJWT({ ...validClaims(), aud: "loa-finn-admin" })
      const result = await validateJWT(token, getJWTConfig(), undefined, { endpointType: "admin" })
      expect(result.ok).toBe(true)
    })

    it("rejects admin token with invoke audience", async () => {
      const token = await signJWT(validClaims())
      const result = await validateJWT(token, getJWTConfig(), undefined, { endpointType: "admin" })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("AUDIENCE_MISMATCH")
      }
    })

    it("accepts s2s token with arrakis audience", async () => {
      const claims = { ...validClaims(), aud: "arrakis" }
      const token = await signJWT(claims)
      const result = await validateJWT(token, getJWTConfig(), undefined, { endpointType: "s2s" })
      expect(result.ok).toBe(true)
    })
  })

  // =========================================================================
  // JTI Namespace
  // =========================================================================

  describe("jti namespace", () => {
    it("namespaces jti with length-prefixed issuer", () => {
      expect(namespaceJti("arrakis", "req-123")).toBe("jti:7:arrakis:req-123")
    })

    it("namespaces with URL-style issuer", () => {
      expect(namespaceJti("https://auth.honeyjar.xyz", "req-456")).toBe("jti:25:https://auth.honeyjar.xyz:req-456")
    })

    it("prevents canonicalization collision (BB-063-004)", () => {
      // Without length prefix, these would collide: both produce "jti:evil:fake:victim"
      const a = namespaceJti("evil", "fake:victim")
      const b = namespaceJti("evil:fake", "victim")
      expect(a).not.toBe(b)
      expect(a).toBe("jti:4:evil:fake:victim")
      expect(b).toBe("jti:9:evil:fake:victim")
    })

    it("isolates jti across issuers (cross-issuer collision prevention)", async () => {
      const guard = new InMemoryJtiReplayGuard(1000)

      // First token from issuer A
      const tokenA = await signJWT({ ...validClaims(), iss: "arrakis", jti: "shared-jti" })
      const resultA = await validateJWT(tokenA, getJWTConfig(), guard, { endpointType: "invoke" })
      expect(resultA.ok).toBe(true)

      // Second token from issuer B with same jti value
      const configB = getJWTConfig({ issuers: ["arrakis", "issuer-b"] })
      const tokenB = await signJWT({ ...validClaims(), iss: "issuer-b", jti: "shared-jti" })

      // Create a separate JWKS server for issuer-b that serves the same key
      // (In practice issuers would have different keys, but for jti isolation test
      // we just need the same signing key to pass signature verification)
      const resultB = await validateJWT(tokenB, configB, guard, { endpointType: "invoke" })
      // Should succeed — different namespace prevents collision
      expect(resultB.ok).toBe(true)

      // Replay with same issuer should be detected
      const tokenA2 = await signJWT({ ...validClaims(), iss: "arrakis", jti: "shared-jti" })
      const resultA2 = await validateJWT(tokenA2, getJWTConfig(), guard, { endpointType: "invoke" })
      expect(resultA2.ok).toBe(false)
      if (!resultA2.ok) {
        expect(resultA2.code).toBe("JTI_REPLAY_DETECTED")
      }

      guard.dispose()
    })
  })

  // =========================================================================
  // JWKS State Machine
  // =========================================================================

  describe("JWKSStateMachine", () => {
    it("starts in DEGRADED state (no successful fetch yet)", () => {
      const machine = new JWKSStateMachine(`http://localhost:${jwksPort}/.well-known/jwks.json`)
      expect(machine.state).toBe("DEGRADED")
    })

    it("transitions to HEALTHY after successful validation", () => {
      const machine = new JWKSStateMachine(`http://localhost:${jwksPort}/.well-known/jwks.json`)
      machine.recordSuccess("key-current")
      expect(machine.state).toBe("HEALTHY")
    })

    it("transitions to STALE after 15 minutes", () => {
      const machine = new JWKSStateMachine(`http://localhost:${jwksPort}/.well-known/jwks.json`)
      machine.recordSuccess("key-current")
      // Simulate 16 minutes ago
      machine._setLastSuccessMs(Date.now() - 16 * 60 * 1000)
      expect(machine.state).toBe("STALE")
    })

    it("transitions to DEGRADED after max staleness (24h default)", () => {
      const machine = new JWKSStateMachine(`http://localhost:${jwksPort}/.well-known/jwks.json`)
      machine.recordSuccess("key-current")
      // Simulate 25 hours ago
      machine._setLastSuccessMs(Date.now() - 25 * 60 * 60 * 1000)
      expect(machine.state).toBe("DEGRADED")
    })

    it("uses compromise mode staleness (1h) when enabled", () => {
      const machine = new JWKSStateMachine(
        `http://localhost:${jwksPort}/.well-known/jwks.json`,
        { compromiseMode: true },
      )
      machine.recordSuccess("key-current")
      // Simulate 2 hours ago — DEGRADED in compromise mode
      machine._setLastSuccessMs(Date.now() - 2 * 60 * 60 * 1000)
      expect(machine.state).toBe("DEGRADED")
    })

    it("tracks known kids", () => {
      const machine = new JWKSStateMachine(`http://localhost:${jwksPort}/.well-known/jwks.json`)
      expect(machine.isKnownKid("key-current")).toBe(false)
      machine.recordSuccess("key-current")
      expect(machine.isKnownKid("key-current")).toBe(true)
      expect(machine.isKnownKid("key-other")).toBe(false)
    })

    it("invalidate clears known kids and resets state", () => {
      const machine = new JWKSStateMachine(`http://localhost:${jwksPort}/.well-known/jwks.json`)
      machine.recordSuccess("key-current")
      expect(machine.state).toBe("HEALTHY")
      expect(machine.knownKidCount).toBe(1)

      machine.invalidate()
      expect(machine.state).toBe("DEGRADED")
      expect(machine.knownKidCount).toBe(0)
    })

    it("rate limits refresh to 1/sec", () => {
      const machine = new JWKSStateMachine(`http://localhost:${jwksPort}/.well-known/jwks.json`)
      const first = machine.refresh()
      const second = machine.refresh()
      // Same reference when rate limited
      expect(first).toBe(second)
    })

    it("circuit breaker opens after 5 consecutive failures", () => {
      const machine = new JWKSStateMachine(`http://localhost:${jwksPort}/.well-known/jwks.json`)
      for (let i = 0; i < 5; i++) machine.recordRefreshFailure()
      // Force past rate limit
      machine._setLastRefreshAttemptMs(Date.now() - 2000)
      const before = machine.getJWKS()
      const after = machine.refresh()
      // Circuit is open — returns same reference (no refresh within 60s cooldown)
      expect(before).toBe(after)
    })

    it("setMaxStaleness updates threshold at runtime", () => {
      const machine = new JWKSStateMachine(`http://localhost:${jwksPort}/.well-known/jwks.json`)
      machine.recordSuccess("key-current")
      machine._setLastSuccessMs(Date.now() - 2 * 60 * 60 * 1000) // 2h ago

      expect(machine.state).toBe("STALE") // 2h < 24h default

      machine.setMaxStaleness(60 * 60 * 1000) // 1h
      expect(machine.state).toBe("DEGRADED") // 2h > 1h
    })

    it("DEGRADED rejects unknown kid in validateJWT", async () => {
      const machine = new JWKSStateMachine(`http://localhost:${jwksPort}/.well-known/jwks.json`)
      // Initialize with a different kid, then degrade
      machine.recordSuccess("key-old")
      machine._setLastSuccessMs(Date.now() - 25 * 60 * 60 * 1000)
      expect(machine.state).toBe("DEGRADED")
      expect(machine.initialized).toBe(true)

      // "key-current" is NOT a known kid — should be rejected
      const token = await signJWT(validClaims())
      const result = await validateJWT(token, getJWTConfig(), undefined, {
        jwksMachine: machine,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("JWKS_DEGRADED")
      }
    })

    it("DEGRADED accepts known kid", async () => {
      const machine = new JWKSStateMachine(`http://localhost:${jwksPort}/.well-known/jwks.json`)
      // Record success then make DEGRADED
      machine.recordSuccess("key-current")
      machine._setLastSuccessMs(Date.now() - 25 * 60 * 60 * 1000)
      expect(machine.state).toBe("DEGRADED")

      const token = await signJWT(validClaims())
      const result = await validateJWT(token, getJWTConfig(), undefined, {
        jwksMachine: machine,
      })
      // Known kid — should pass through to signature verification
      expect(result.ok).toBe(true)
    })

    it("STALE validates known kids without refresh", async () => {
      const machine = new JWKSStateMachine(`http://localhost:${jwksPort}/.well-known/jwks.json`)
      machine.recordSuccess("key-current")
      machine._setLastSuccessMs(Date.now() - 16 * 60 * 1000)
      expect(machine.state).toBe("STALE")

      const token = await signJWT(validClaims())
      const result = await validateJWT(token, getJWTConfig(), undefined, {
        jwksMachine: machine,
      })
      expect(result.ok).toBe(true)
    })

    // Contract test: extended outage → DEGRADED → all-reject for unknown kids
    it("extended outage transitions to DEGRADED and rejects unknown kids", async () => {
      const machine = new JWKSStateMachine(`http://localhost:${jwksPort}/.well-known/jwks.json`)
      machine.recordSuccess("key-old")
      // Simulate 25h outage
      machine._setLastSuccessMs(Date.now() - 25 * 60 * 60 * 1000)
      expect(machine.state).toBe("DEGRADED")

      // Unknown kid (key-current is not known)
      const token = await signJWT(validClaims(), { kid: "key-current" })
      const result = await validateJWT(token, getJWTConfig(), undefined, {
        jwksMachine: machine,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("JWKS_DEGRADED")
      }
    })
  })

  // =========================================================================
  // Hono Middleware
  // =========================================================================

  describe("jwtAuthMiddleware", () => {
    function createTestApp(config: FinnConfig, endpointType?: EndpointType): Hono {
      const app = new Hono()
      app.use("/api/v1/*", jwtAuthMiddleware(config, undefined, endpointType))
      app.get("/api/v1/test", (c) => {
        const tenant = c.get("tenant")
        return c.json({ tenant })
      })
      return app
    }

    function mockConfig(overrides?: Partial<JWTConfig>): FinnConfig {
      return {
        jwt: getJWTConfig(overrides),
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
      const config = mockConfig({ enabled: false })
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

  // =========================================================================
  // WebSocket JWT
  // =========================================================================

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
      const config = getJWTConfig({ enabled: false })
      const token = await signJWT(validClaims())
      const result = await validateWsJWT(token, config)
      expect(result).toBeNull()
    })

    it("returns null for invalid token", async () => {
      const result = await validateWsJWT("invalid-token", getJWTConfig())
      expect(result).toBeNull()
    })
  })

  // =========================================================================
  // JWKS Invalidation Handler
  // =========================================================================

  describe("jwksInvalidateHandler", () => {
    it("rejects without admin:jwks scope", async () => {
      const app = new Hono()
      app.post("/admin/jwks/invalidate", jwksInvalidateHandler())

      const res = await app.request("/admin/jwks/invalidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
    })
  })

  // =========================================================================
  // Pool Claim Passthrough (Sprint 51 — T5)
  // =========================================================================

  describe("pool claim passthrough", () => {
    it("token with pool_id claim passes validateClaims", async () => {
      const token = await signJWT({ ...validClaims(), pool_id: "cheap" })
      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.claims.pool_id).toBe("cheap")
      }
    })

    it("token with allowed_pools claim passes validateClaims", async () => {
      const token = await signJWT({
        ...validClaims(),
        allowed_pools: ["cheap", "fast-code"],
      })
      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.claims.allowed_pools).toEqual(["cheap", "fast-code"])
      }
    })

    it("token with unknown extra claims passes (backward compat)", async () => {
      const token = await signJWT({
        ...validClaims(),
        some_future_claim: "value",
        another_claim: 42,
      })
      const result = await validateJWT(token, getJWTConfig())
      expect(result.ok).toBe(true)
    })
  })

  // =========================================================================
  // Protocol Constants
  // =========================================================================

  describe("protocol constants", () => {
    it("JTI_POLICY matches loa-hounfour spec", () => {
      expect(JTI_POLICY.invoke.required).toBe(true)
      expect(JTI_POLICY.admin.required).toBe(true)
      expect(JTI_POLICY.s2s_get.required).toBe(false)
      expect(JTI_POLICY.s2s_get.compensating).toBe("exp <= 60s")
    })

    it("AUDIENCE_MAP matches loa-hounfour spec", () => {
      expect(AUDIENCE_MAP.invoke).toBe("loa-finn")
      expect(AUDIENCE_MAP.admin).toBe("loa-finn-admin")
      expect(AUDIENCE_MAP.s2s).toBe("arrakis")
    })
  })

  // =========================================================================
  // Golden Vectors (from loa-hounfour conformance.json)
  // =========================================================================

  describe("golden vectors: JWT conformance", () => {
    const multiIssuerConfig = () => getJWTConfig({
      issuers: ["https://auth.honeyjar.xyz", "arrakis"],
    })

    it("jwt-valid-invoke: Valid invoke JWT with all required claims", async () => {
      const vec = conformanceVectors.vectors.find((v: { id: string }) => v.id === "jwt-valid-invoke")
      const token = await signJWT(vec.claims)
      const result = await validateJWT(token, multiIssuerConfig())
      expect(result.ok).toBe(true)
    })

    it("jwt-expired: Expired JWT (exp in the past)", async () => {
      const vec = conformanceVectors.vectors.find((v: { id: string }) => v.id === "jwt-expired")
      // Must create actually expired token — signJWT override won't work
      const nowSec = Math.floor(Date.now() / 1000)
      const token = await new SignJWT({ ...vec.claims } as Record<string, unknown>)
        .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "key-current" })
        .setIssuedAt(nowSec - 7200)
        .setExpirationTime(nowSec - 3600)
        .sign(currentKeyPair.privateKey)
      const result = await validateJWT(token, multiIssuerConfig())
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("JWT_INVALID") // jose rejects expired
      }
    })

    it("jwt-wrong-aud: Wrong audience (arrakis instead of loa-finn)", async () => {
      const vec = conformanceVectors.vectors.find((v: { id: string }) => v.id === "jwt-wrong-aud")
      const token = await signJWT(vec.claims)
      const result = await validateJWT(token, multiIssuerConfig(), undefined, { endpointType: "invoke" })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("AUDIENCE_MISMATCH")
      }
    })

    it("jwt-rotated-key: JWT signed with previous key (kid mismatch on primary, valid on rotated)", async () => {
      previousKeyPair = currentKeyPair
      currentKeyPair = await generateKeyPair("ES256")

      const vec = conformanceVectors.vectors.find((v: { id: string }) => v.id === "jwt-rotated-key")
      const token = await signJWT(vec.claims, {
        kid: "key-previous",
        privateKey: previousKeyPair.privateKey,
      })
      const result = await validateJWT(token, multiIssuerConfig())
      expect(result.ok).toBe(true)

      previousKeyPair = null
    })

    it("jwt-disallowed-iss: Issuer not in allowlist", async () => {
      const vec = conformanceVectors.vectors.find((v: { id: string }) => v.id === "jwt-disallowed-iss")
      const token = await signJWT(vec.claims)
      const result = await validateJWT(token, multiIssuerConfig())
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("ISSUER_NOT_ALLOWED")
      }
    })

    it("jwt-jwks-timeout: JWKS endpoint unreachable — DEGRADED known kid accepted", async () => {
      const machine = new JWKSStateMachine(`http://localhost:${jwksPort}/.well-known/jwks.json`)
      // Record "key-current" as known, then simulate 25h outage
      machine.recordSuccess("key-current")
      machine._setLastSuccessMs(Date.now() - 25 * 60 * 60 * 1000)
      expect(machine.state).toBe("DEGRADED")

      const vec = conformanceVectors.vectors.find((v: { id: string }) => v.id === "jwt-jwks-timeout")
      // Use actual "key-current" kid (matches JWKS server) instead of conceptual "known-kid"
      const token = await signJWT(vec.claims, { kid: "key-current" })
      const result = await validateJWT(token, multiIssuerConfig(), undefined, { jwksMachine: machine })
      expect(result.ok).toBe(true)
    })
  })

  // =========================================================================
  // Contract Tests
  // =========================================================================

  describe("contract tests", () => {
    it("CT-1: rejects missing kid in header", async () => {
      // Craft a token without kid
      const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url")
      const payload = Buffer.from(JSON.stringify(validClaims())).toString("base64url")
      const fakeToken = `${header}.${payload}.fakesignature`

      const result = await validateJWT(fakeToken, getJWTConfig())
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("JWT_STRUCTURAL_INVALID")
      }
    })

    it("CT-2: rejects wrong alg in header", async () => {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" })).toString("base64url")
      const payload = Buffer.from(JSON.stringify(validClaims())).toString("base64url")
      const fakeToken = `${header}.${payload}.fakesignature`

      const result = await validateJWT(fakeToken, getJWTConfig())
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("JWT_STRUCTURAL_INVALID")
      }
    })

    it("CT-3: audience mismatch per endpoint type", async () => {
      // invoke token with s2s audience
      const token = await signJWT({ ...validClaims(), aud: "arrakis" })
      const result = await validateJWT(token, getJWTConfig(), undefined, { endpointType: "invoke" })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("AUDIENCE_MISMATCH")
      }
    })

    it("CT-4: S2S short-exp exempt path (no jti required)", async () => {
      const claims = {
        ...validClaims(),
        aud: "arrakis",
      }
      delete claims.jti  // Remove jti
      const token = await signJWT(claims)
      const result = await validateJWT(token, getJWTConfig(), undefined, { endpointType: "s2s" })
      expect(result.ok).toBe(true)
    })

    it("CT-5: rejects alg:none JWT (CVE-2015-9235) (BB-PR63-F003)", async () => {
      // Construct a JWT with alg: none and no signature
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
      const payload = Buffer.from(JSON.stringify(validClaims())).toString("base64url")
      const noneToken = `${header}.${payload}.`

      const result = await validateJWT(noneToken, getJWTConfig())
      expect(result.ok).toBe(false)
      if (!result.ok) {
        // Should be rejected at structural check (no kid) or algorithm validation
        expect(["JWT_STRUCTURAL_INVALID", "JWT_INVALID"]).toContain(result.code)
      }
    })

    it("CT-6: rejects alg:HS256 with forged HMAC signature (BB-PR63-F003)", async () => {
      // Construct a JWT with HS256 header but ES256-signed body
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "key-current" })).toString("base64url")
      const payload = Buffer.from(JSON.stringify(validClaims())).toString("base64url")
      const forgedToken = `${header}.${payload}.forged-hmac-signature`

      const result = await validateJWT(forgedToken, getJWTConfig())
      expect(result.ok).toBe(false)
      if (!result.ok) {
        // Rejected because only ES256 is in the algorithms allowlist
        expect(["JWT_STRUCTURAL_INVALID", "JWT_INVALID"]).toContain(result.code)
      }
    })
  })
})
