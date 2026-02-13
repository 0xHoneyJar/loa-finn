// tests/finn/pool-enforcement.test.ts — Pool Claim Enforcement Tests (SDD §4)
// Sprint 51: ≥37 test cases covering confused deputy prevention.
// Sprint 52: +11 tests from Bridgebuilder findings (logPoolMismatch, strict mode, empty pools).
//
// Table of Contents:
//   §1:  enforcePoolClaims pure function (9 tests)
//   §2:  pool_id validation (5 tests)
//   §3:  allowed_pools mismatch (5 tests)
//   §4:  hounfourAuth middleware (4 tests)
//   §5:  validateAndEnforceWsJWT (4 tests)
//   §6:  selectAuthorizedPool (5 tests)
//   §7:  strict mode (4 tests)
//   §8:  error code taxonomy (2 tests)
//   §9:  equivalence golden test (1 test)
//   §10: bypass prevention (2 tests)
//   §11: logPoolMismatch behavior (4 tests)

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
// Bypass prevention (source-level) imports
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Hono } from "hono"
import { generateKeyPair, exportJWK, SignJWT } from "jose"
import { serve } from "@hono/node-server"
import {
  enforcePoolClaims,
  hounfourAuth,
  validateAndEnforceWsJWT,
  selectAuthorizedPool,
  logPoolMismatch,
  type PoolEnforcementConfig,
  type PoolMismatch,
} from "../../src/hounfour/pool-enforcement.js"
import {
  authenticateRequest,
  jwtAuthMiddleware,
  resetJWKSCache,
  type JWTClaims,
  type TenantContext,
  type JWTConfig,
} from "../../src/hounfour/jwt-auth.js"
import { HounfourError, type HounfourErrorCode } from "../../src/hounfour/errors.js"
import type { FinnConfig } from "../../src/config.js"
import type { PoolId } from "@0xhoneyjar/loa-hounfour"
import { getAccessiblePools } from "../../src/hounfour/tier-bridge.js"

// --- Test JWKS Server ---

let jwksServer: ReturnType<typeof serve>
let jwksPort: number
let keyPair: Awaited<ReturnType<typeof generateKeyPair>>

async function startJWKSServer(): Promise<void> {
  keyPair = await generateKeyPair("ES256")
  const app = new Hono()
  app.get("/.well-known/jwks.json", async (c) => {
    const jwk = await exportJWK(keyPair.publicKey)
    jwk.kid = "test-key"
    jwk.alg = "ES256"
    jwk.use = "sig"
    return c.json({ keys: [jwk] })
  })
  return new Promise((r) => {
    jwksServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
      jwksPort = info.port
      r()
    })
  })
}

function jwtConfig(overrides?: Partial<JWTConfig>): JWTConfig {
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

function mockFinnConfig(overrides?: Partial<JWTConfig>): FinnConfig {
  return { jwt: jwtConfig(overrides) } as FinnConfig
}

async function signJWT(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(keyPair.privateKey)
}

/** Construct JWTClaims for pure function tests (no signing needed) */
function makeClaims(overrides?: Record<string, unknown>): JWTClaims {
  return {
    iss: "arrakis",
    aud: "loa-finn",
    sub: "user:discord:123",
    tenant_id: "community:thj",
    tier: "pro",
    req_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: "test-jti-001",
    ...overrides,
  } as JWTClaims
}

/**
 * Construct TenantContext for selectAuthorizedPool tests.
 * NOTE: If overriding both `claims` and `resolvedPools`, the caller must ensure
 * resolvedPools matches claims.tier. The helper does NOT auto-derive resolvedPools
 * from overridden claims to allow testing invariant violations.
 */
function makeTenantCtx(overrides?: Partial<TenantContext>): TenantContext {
  const claims = makeClaims(overrides?.claims as Record<string, unknown> | undefined)
  return {
    claims,
    resolvedPools: getAccessiblePools(claims.tier),
    requestedPool: null,
    isNFTRouted: false,
    isBYOK: false,
    ...overrides,
  }
}

/**
 * JWT claims for signing (include standard fields).
 * Parallel structure to jwt-auth.test.ts validClaims() — keep in sync.
 */
function signableClaims(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    iss: "arrakis",
    aud: "loa-finn",
    sub: "user:discord:123",
    tenant_id: "community:thj",
    tier: "pro",
    req_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    jti: "test-jti-001",
    ...overrides,
  }
}

// --- Tests ---

describe("Pool Enforcement (Sprint 51+52)", () => {
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
  // §1: enforcePoolClaims pure function (9 tests)
  // =========================================================================

  describe("enforcePoolClaims", () => {
    it("free tier → resolvedPools = [cheap]", () => {
      const result = enforcePoolClaims(makeClaims({ tier: "free" }))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect([...result.resolvedPools]).toEqual([...getAccessiblePools("free")])
        expect(result.resolvedPools).toContain("cheap")
        expect(result.resolvedPools.length).toBe(1)
      }
    })

    it("pro tier → resolvedPools = [cheap, fast-code, reviewer]", () => {
      const result = enforcePoolClaims(makeClaims({ tier: "pro" }))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect([...result.resolvedPools]).toEqual([...getAccessiblePools("pro")])
        expect(result.resolvedPools.length).toBe(3)
      }
    })

    it("enterprise tier → all 5 pools", () => {
      const result = enforcePoolClaims(makeClaims({ tier: "enterprise" }))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect([...result.resolvedPools]).toEqual([...getAccessiblePools("enterprise")])
        expect(result.resolvedPools.length).toBe(5)
      }
    })

    it("no pool_id, no allowed_pools → ok with null requestedPool, null mismatch", () => {
      const result = enforcePoolClaims(makeClaims())
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.requestedPool).toBeNull()
        expect(result.mismatch).toBeNull()
      }
    })

    it("invalid pool_id → UNKNOWN_POOL", () => {
      const result = enforcePoolClaims(makeClaims({ pool_id: "not-a-pool" }))
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("UNKNOWN_POOL")
      }
    })

    it("unauthorized pool_id → POOL_ACCESS_DENIED", () => {
      const result = enforcePoolClaims(makeClaims({ tier: "free", pool_id: "reasoning" }))
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("POOL_ACCESS_DENIED")
      }
    })

    it("valid pool_id → ok with requestedPool set", () => {
      const result = enforcePoolClaims(makeClaims({ tier: "free", pool_id: "cheap" }))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.requestedPool).toBe("cheap")
      }
    })

    it("gracefully handles edge case claims", () => {
      // Claims with empty pool_id should be treated as absent
      const result = enforcePoolClaims(makeClaims({ pool_id: "" }))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.requestedPool).toBeNull()
      }
    })

    it("error branch carries details for server-side diagnostics", () => {
      const result = enforcePoolClaims(makeClaims({ tier: "free", pool_id: "reasoning" }))
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.details).toBeDefined()
        expect(result.details?.pool_id).toBe("reasoning")
        expect(result.details?.tier).toBe("free")
      }
    })
  })

  // =========================================================================
  // §2: pool_id validation (5 tests)
  // =========================================================================

  describe("pool_id validation", () => {
    it("pool_id: 'cheap' + tier: 'free' → allowed", () => {
      const result = enforcePoolClaims(makeClaims({ tier: "free", pool_id: "cheap" }))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.requestedPool).toBe("cheap")
      }
    })

    it("pool_id: 'reasoning' + tier: 'free' → POOL_ACCESS_DENIED (N1)", () => {
      const result = enforcePoolClaims(makeClaims({ tier: "free", pool_id: "reasoning" }))
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("POOL_ACCESS_DENIED")
      }
    })

    it("pool_id: 'not-a-pool' → UNKNOWN_POOL (N2)", () => {
      const result = enforcePoolClaims(makeClaims({ pool_id: "not-a-pool" }))
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("UNKNOWN_POOL")
      }
    })

    it("no pool_id → passthrough", () => {
      const result = enforcePoolClaims(makeClaims())
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.requestedPool).toBeNull()
      }
    })

    it("pool_id: 'cheap' but routing selects different pool → POOL_ACCESS_DENIED (N5)", () => {
      // Enterprise tier: pool_id = "cheap", but model_preferences resolve to "reasoning"
      const ctx = makeTenantCtx({
        claims: makeClaims({
          tier: "enterprise",
          pool_id: "cheap",
          model_preferences: { default: "reasoning" },
        }),
        resolvedPools: getAccessiblePools("enterprise"),
        requestedPool: "cheap" as PoolId,
      })

      try {
        selectAuthorizedPool(ctx, "chat")
        expect.unreachable("should have thrown")
      } catch (e) {
        expect(e).toBeInstanceOf(HounfourError)
        expect((e as HounfourError).code).toBe("POOL_ACCESS_DENIED")
      }
    })
  })

  // =========================================================================
  // §3: allowed_pools mismatch (5 tests)
  // =========================================================================

  describe("allowed_pools mismatch", () => {
    it("subset: ['cheap'] + tier: 'pro' → info mismatch, resolvedPools from tier", () => {
      const result = enforcePoolClaims(makeClaims({
        tier: "pro",
        allowed_pools: ["cheap"],
      }))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.mismatch).not.toBeNull()
        expect(result.mismatch!.type).toBe("subset")
        expect([...result.resolvedPools]).toEqual([...getAccessiblePools("pro")])
      }
    })

    it("superset: ['reasoning'] + tier: 'free' → warn mismatch (N3)", () => {
      const result = enforcePoolClaims(makeClaims({
        tier: "free",
        allowed_pools: ["reasoning"],
      }))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.mismatch).not.toBeNull()
        expect(result.mismatch!.type).toBe("superset")
        expect(result.mismatch!.entries).toContain("reasoning")
        expect([...result.resolvedPools]).toEqual([...getAccessiblePools("free")])
      }
    })

    it("invalid entry: ['not-a-pool'] → error mismatch, resolvedPools from tier", () => {
      const result = enforcePoolClaims(makeClaims({
        allowed_pools: ["not-a-pool"],
      }))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.mismatch).not.toBeNull()
        expect(result.mismatch!.type).toBe("invalid_entry")
        expect(result.mismatch!.entries).toContain("not-a-pool")
      }
    })

    it("absent → no mismatch", () => {
      const result = enforcePoolClaims(makeClaims())
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.mismatch).toBeNull()
      }
    })

    it("confused deputy: free + allowed_pools: ['reasoning'] + model_prefs → denied by resolvedPools (N6)", () => {
      // enforcePoolClaims passes (allowed_pools is advisory only)
      const claims = makeClaims({
        tier: "free",
        allowed_pools: ["reasoning"],
        model_preferences: { default: "reasoning" },
      })
      const enforcement = enforcePoolClaims(claims)
      expect(enforcement.ok).toBe(true)

      // But selectAuthorizedPool rejects: "reasoning" not in resolvedPools ["cheap"]
      if (enforcement.ok) {
        const ctx = makeTenantCtx({
          claims,
          resolvedPools: [...enforcement.resolvedPools],
          requestedPool: enforcement.requestedPool,
        })

        try {
          selectAuthorizedPool(ctx, "chat")
          expect.unreachable("should have thrown")
        } catch (e) {
          expect(e).toBeInstanceOf(HounfourError)
          expect((e as HounfourError).code).toBe("POOL_ACCESS_DENIED")
        }
      }
    })
  })

  // =========================================================================
  // §4: hounfourAuth middleware (4 tests)
  // =========================================================================

  describe("hounfourAuth middleware", () => {
    function createApp(config: FinnConfig): Hono {
      const app = new Hono()
      app.use("/api/v1/*", hounfourAuth(config))
      app.get("/api/v1/test", (c) => {
        const tenant = c.get("tenant") as TenantContext
        return c.json({
          tenant_id: tenant.claims.tenant_id,
          resolvedPools: [...tenant.resolvedPools],
          requestedPool: tenant.requestedPool,
        })
      })
      return app
    }

    it("valid JWT → TenantContext with populated resolvedPools", async () => {
      const app = createApp(mockFinnConfig())
      const token = await signJWT(signableClaims({ tier: "pro" }))

      const res = await app.request("/api/v1/test", {
        headers: { Authorization: `Bearer ${token}` },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.resolvedPools.length).toBeGreaterThan(0)
      expect(body.resolvedPools).toEqual([...getAccessiblePools("pro")])
    })

    it("invalid JWT → 401 passthrough", async () => {
      const app = createApp(mockFinnConfig())
      const res = await app.request("/api/v1/test")
      expect(res.status).toBe(401)
    })

    it("valid JWT, unauthorized pool_id → 403 POOL_ACCESS_DENIED (N1)", async () => {
      const app = createApp(mockFinnConfig())
      const token = await signJWT(signableClaims({ tier: "free", pool_id: "reasoning" }))

      const res = await app.request("/api/v1/test", {
        headers: { Authorization: `Bearer ${token}` },
      })

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.code).toBe("POOL_ACCESS_DENIED")
    })

    it("valid JWT, no pool claims → resolvedPools populated from tier", async () => {
      const app = createApp(mockFinnConfig())
      const token = await signJWT(signableClaims({ tier: "free" }))

      const res = await app.request("/api/v1/test", {
        headers: { Authorization: `Bearer ${token}` },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.resolvedPools).toEqual([...getAccessiblePools("free")])
      expect(body.requestedPool).toBeNull()
    })
  })

  // =========================================================================
  // §5: validateAndEnforceWsJWT (4 tests)
  // =========================================================================

  describe("validateAndEnforceWsJWT", () => {
    it("valid token → { ok: true, context } with resolvedPools", async () => {
      const token = await signJWT(signableClaims({ tier: "pro" }))
      const result = await validateAndEnforceWsJWT(token, jwtConfig())
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.context.resolvedPools.length).toBeGreaterThan(0)
        expect([...result.context.resolvedPools]).toEqual([...getAccessiblePools("pro")])
      }
    })

    it("no token → { ok: false, reason: 'UNAUTHENTICATED' }", async () => {
      const result = await validateAndEnforceWsJWT(undefined, jwtConfig())
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe("UNAUTHENTICATED")
      }
    })

    it("valid token, bad pool_id → { ok: false, reason: 'FORBIDDEN' } (N7)", async () => {
      const token = await signJWT(signableClaims({ pool_id: "not-a-pool" }))
      const result = await validateAndEnforceWsJWT(token, jwtConfig())
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe("FORBIDDEN")
        expect(result.code).toBe("UNKNOWN_POOL")
      }
    })

    it("failure result has no context — no downstream handler runs (N7)", async () => {
      const result = await validateAndEnforceWsJWT(undefined, jwtConfig())
      expect(result.ok).toBe(false)
      // Discriminated union: context only exists on ok branch
      expect("context" in result).toBe(false)
    })
  })

  // =========================================================================
  // §6: selectAuthorizedPool (5 tests)
  // =========================================================================

  describe("selectAuthorizedPool", () => {
    it("binding match → returns poolId", () => {
      // Enterprise tier, requestedPool = "cheap", routing resolves "cheap" (default for task)
      const ctx = makeTenantCtx({
        claims: makeClaims({ tier: "enterprise", pool_id: "cheap" }),
        resolvedPools: getAccessiblePools("enterprise"),
        requestedPool: "cheap" as PoolId,
      })
      // With no model_preferences, resolvePool returns TIER_DEFAULT_POOL[enterprise]
      // Use a taskType that doesn't trigger model_preferences
      const defaultPool = selectAuthorizedPool(
        makeTenantCtx({
          claims: makeClaims({ tier: "enterprise" }),
          resolvedPools: getAccessiblePools("enterprise"),
          requestedPool: null,
        }),
        "chat",
      )
      // Now test with binding that matches
      const ctx2 = makeTenantCtx({
        claims: makeClaims({ tier: "enterprise" }),
        resolvedPools: getAccessiblePools("enterprise"),
        requestedPool: defaultPool,
      })
      const result = selectAuthorizedPool(ctx2, "chat")
      expect(result).toBe(defaultPool)
    })

    it("binding mismatch → throws POOL_ACCESS_DENIED (N5)", () => {
      const ctx = makeTenantCtx({
        claims: makeClaims({
          tier: "enterprise",
          model_preferences: { default: "reasoning" },
        }),
        resolvedPools: getAccessiblePools("enterprise"),
        requestedPool: "cheap" as PoolId, // Binds to cheap, but routing selects reasoning
      })

      try {
        selectAuthorizedPool(ctx, "chat")
        expect.unreachable("should have thrown")
      } catch (e) {
        expect(e).toBeInstanceOf(HounfourError)
        expect((e as HounfourError).code).toBe("POOL_ACCESS_DENIED")
        expect((e as HounfourError).message).toContain("JWT binds to")
      }
    })

    it("resolvedPools membership → returns poolId", () => {
      // Pro tier, routing resolves a pool within resolvedPools
      const ctx = makeTenantCtx({
        claims: makeClaims({ tier: "pro" }),
        resolvedPools: getAccessiblePools("pro"),
        requestedPool: null,
      })
      const result = selectAuthorizedPool(ctx, "chat")
      expect(getAccessiblePools("pro")).toContain(result)
    })

    it("pool not in resolvedPools → throws POOL_ACCESS_DENIED (N4)", () => {
      // Artificially restrict resolvedPools to just ["cheap"]
      const ctx = makeTenantCtx({
        claims: makeClaims({
          tier: "pro",
          model_preferences: { default: "reviewer" },
        }),
        resolvedPools: ["cheap" as PoolId], // Intentionally restricted
        requestedPool: null,
      })

      try {
        selectAuthorizedPool(ctx, "chat")
        expect.unreachable("should have thrown")
      } catch (e) {
        expect(e).toBeInstanceOf(HounfourError)
        expect((e as HounfourError).code).toBe("POOL_ACCESS_DENIED")
        expect((e as HounfourError).message).toContain("not in tenant's resolved pools")
      }
    })

    it("empty resolvedPools → throws POOL_ACCESS_DENIED (invariant violation)", () => {
      const ctx = makeTenantCtx({
        claims: makeClaims({ tier: "pro" }),
        resolvedPools: [] as PoolId[], // Empty — invariant violation
        requestedPool: null,
      })

      try {
        selectAuthorizedPool(ctx, "chat")
        expect.unreachable("should have thrown")
      } catch (e) {
        expect(e).toBeInstanceOf(HounfourError)
        expect((e as HounfourError).code).toBe("POOL_ACCESS_DENIED")
        expect((e as HounfourError).message).toContain("No resolved pools")
      }
    })
  })

  // =========================================================================
  // §7: strict mode (4 tests)
  // =========================================================================

  describe("strict mode", () => {
    it("strictMode: true + superset → POOL_ACCESS_DENIED", () => {
      const result = enforcePoolClaims(
        makeClaims({ tier: "free", allowed_pools: ["reasoning"] }),
        { strictMode: true },
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("POOL_ACCESS_DENIED")
      }
    })

    it("strictMode: false + superset → ok with warn mismatch", () => {
      const result = enforcePoolClaims(
        makeClaims({ tier: "free", allowed_pools: ["reasoning"] }),
        { strictMode: false },
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.mismatch).not.toBeNull()
        expect(result.mismatch!.type).toBe("superset")
      }
    })

    it("strictMode: true + subset → ok (subset is informational only)", () => {
      const result = enforcePoolClaims(
        makeClaims({ tier: "pro", allowed_pools: ["cheap"] }),
        { strictMode: true },
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.mismatch).not.toBeNull()
        expect(result.mismatch!.type).toBe("subset")
      }
    })

    it("strictMode: true + invalid_entry → ok with mismatch (invalid entries logged, not blocked)", () => {
      const result = enforcePoolClaims(
        makeClaims({ allowed_pools: ["not-a-pool"] }),
        { strictMode: true },
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.mismatch).not.toBeNull()
        expect(result.mismatch!.type).toBe("invalid_entry")
      }
    })
  })

  // =========================================================================
  // §8: error code taxonomy (2 tests)
  // =========================================================================

  describe("error code taxonomy", () => {
    it("compile-time: POOL_ACCESS_DENIED and UNKNOWN_POOL are valid HounfourErrorCodes", () => {
      // These assignments verify the types exist in the union at compile time.
      // If HounfourErrorCode doesn't include these, TypeScript fails to compile.
      const code1: Extract<HounfourErrorCode, "POOL_ACCESS_DENIED"> = "POOL_ACCESS_DENIED"
      const code2: Extract<HounfourErrorCode, "UNKNOWN_POOL"> = "UNKNOWN_POOL"
      expect(code1).toBe("POOL_ACCESS_DENIED")
      expect(code2).toBe("UNKNOWN_POOL")
    })

    it("runtime: JSON error shape for both codes includes { error, code }", () => {
      const err1 = new HounfourError("POOL_ACCESS_DENIED", "test denied", { poolId: "reasoning" })
      const json1 = err1.toJSON()
      expect(json1.code).toBe("POOL_ACCESS_DENIED")
      expect(json1.error).toBe("HounfourError")
      expect(json1.context).toEqual({ poolId: "reasoning" })

      const err2 = new HounfourError("UNKNOWN_POOL", "test unknown", { poolId: "fake" })
      const json2 = err2.toJSON()
      expect(json2.code).toBe("UNKNOWN_POOL")
      expect(json2.error).toBe("HounfourError")
    })
  })

  // =========================================================================
  // §9: equivalence golden test (1 test)
  // =========================================================================

  describe("equivalence golden test", () => {
    it("authenticateRequest matches jwtAuthMiddleware for accept/reject across fixtures", async () => {
      const config = mockFinnConfig()

      // Fixtures: valid, missing header, invalid token, expired-style
      const validToken = await signJWT(signableClaims())
      const fixtures: Array<{ label: string; authHeader: string | undefined }> = [
        { label: "valid JWT", authHeader: `Bearer ${validToken}` },
        { label: "missing header", authHeader: undefined },
        { label: "opaque token", authHeader: "Bearer some-opaque-token" },
        { label: "no bearer prefix", authHeader: validToken },
      ]

      for (const { label, authHeader } of fixtures) {
        // Path A: authenticateRequest (direct)
        const directResult = await authenticateRequest({
          authorizationHeader: authHeader,
          jwtConfig: config.jwt,
        })

        // Path B: jwtAuthMiddleware (via Hono)
        const app = new Hono()
        app.use("/*", jwtAuthMiddleware(config))
        app.get("/test", (c) => c.json({ ok: true }))

        const headers: Record<string, string> = {}
        if (authHeader) headers.Authorization = authHeader
        const res = await app.request("/test", { headers })

        // Both must agree on accept/reject
        if (directResult.ok) {
          expect(res.status).toBe(200)
        } else {
          expect(res.status).toBe(directResult.status)
        }
      }
    })
  })

  // =========================================================================
  // §10: bypass prevention (2 tests)
  // =========================================================================

  describe("bypass prevention", () => {
    it("server.ts does not import from jwt-auth", () => {
      const serverSrc = readFileSync(
        resolve(import.meta.dirname ?? ".", "../../src/gateway/server.ts"),
        "utf-8",
      )
      // Must not contain any import from jwt-auth
      expect(serverSrc).not.toMatch(/from\s+["'].*jwt-auth/)
    })

    it("resolvePool is only called in tier-bridge.ts and pool-enforcement.ts", () => {
      const srcDir = resolve(import.meta.dirname ?? ".", "../../src")
      const filesToCheck = [
        "gateway/server.ts",
        "hounfour/router.ts",
        "hounfour/jwt-auth.ts",
      ]

      for (const file of filesToCheck) {
        const content = readFileSync(resolve(srcDir, file), "utf-8")
        // Should not import resolvePool (only pool-enforcement.ts and tier-bridge.ts may)
        const importMatch = content.match(/import\s+\{[^}]*resolvePool[^}]*\}/)
        expect(importMatch).toBeNull()
      }
    })
  })

  // =========================================================================
  // §11: logPoolMismatch behavior (4 tests)
  // =========================================================================

  describe("logPoolMismatch", () => {
    it("subset mismatch → console.info", () => {
      const spy = vi.spyOn(console, "info").mockImplementation(() => {})
      const claims = makeClaims({ tier: "pro", allowed_pools: ["cheap"] })
      const mismatch: PoolMismatch = { type: "subset", count: 2 }

      logPoolMismatch(claims, mismatch)

      expect(spy).toHaveBeenCalledOnce()
      expect(spy.mock.calls[0][0]).toBe("[pool-enforcement]")
      spy.mockRestore()
    })

    it("superset mismatch → console.warn", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const claims = makeClaims({ tier: "free", allowed_pools: ["reasoning"] })
      const mismatch: PoolMismatch = { type: "superset", count: 1, entries: ["reasoning"] }

      logPoolMismatch(claims, mismatch)

      expect(spy).toHaveBeenCalledOnce()
      expect(spy.mock.calls[0][0]).toBe("[pool-enforcement]")
      spy.mockRestore()
    })

    it("invalid_entry mismatch → console.error", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {})
      const claims = makeClaims({ allowed_pools: ["not-a-pool"] })
      const mismatch: PoolMismatch = { type: "invalid_entry", count: 1, entries: ["not-a-pool"] }

      logPoolMismatch(claims, mismatch)

      expect(spy).toHaveBeenCalledOnce()
      expect(spy.mock.calls[0][0]).toBe("[pool-enforcement]")
      spy.mockRestore()
    })

    it("debugLogging: true → includes claimed_hash and derived_hash", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const claims = makeClaims({ tier: "free", allowed_pools: ["reasoning"] })
      const mismatch: PoolMismatch = { type: "superset", count: 1, entries: ["reasoning"] }

      logPoolMismatch(claims, mismatch, { debugLogging: true })

      expect(spy).toHaveBeenCalledOnce()
      const logMsg = spy.mock.calls[0][1] as string
      const parsed = JSON.parse(logMsg)
      expect(parsed.claimed_hash).toBeDefined()
      expect(parsed.derived_hash).toBeDefined()
      expect(typeof parsed.claimed_hash).toBe("string")
      expect(typeof parsed.derived_hash).toBe("string")
      spy.mockRestore()
    })
  })
})
