// src/hounfour/jwt-auth.ts — JWT Validation Middleware (SDD §3.1, T-A.1)
// Validates ES256 JWTs from arrakis, extracts TenantContext onto Hono context.

import { createHash, timingSafeEqual } from "node:crypto"
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from "jose"
import type { Context, Next } from "hono"
import type { FinnConfig } from "../config.js"
import type { JtiReplayGuard } from "./jti-replay.js"
import { deriveJtiTtl } from "./jti-replay.js"

// --- Interfaces ---

export interface JWTClaims {
  iss: string
  aud: string
  sub: string
  tenant_id: string
  tier: "free" | "pro" | "enterprise"
  nft_id?: string
  model_preferences?: Record<string, string>
  byok?: boolean
  req_hash: string
  iat: number
  exp: number
  jti?: string
}

export interface TenantContext {
  claims: JWTClaims
  resolvedPools: string[]
  isNFTRouted: boolean
  isBYOK: boolean
}

export interface JWTConfig {
  enabled: boolean
  issuer: string
  audience: string
  jwksUrl: string
  clockSkewSeconds: number
  maxTokenLifetimeSeconds: number
}

// --- JWKS Client with TTL Cache ---

interface CachedJWKS {
  jwks: ReturnType<typeof createRemoteJWKSet>
  createdAt: number
}

const JWKS_TTL_MS = 5 * 60 * 1000 // 5 minutes

let jwksCache: CachedJWKS | null = null
let jwksCacheUrl: string | null = null

function getJWKS(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const now = Date.now()
  if (jwksCache && jwksCacheUrl === jwksUrl && (now - jwksCache.createdAt) < JWKS_TTL_MS) {
    return jwksCache.jwks
  }

  const jwks = createRemoteJWKSet(new URL(jwksUrl))
  jwksCache = { jwks, createdAt: now }
  jwksCacheUrl = jwksUrl
  return jwks
}

/** Force refetch JWKS (on kid cache miss) */
function invalidateJWKSCache(): void {
  jwksCache = null
  jwksCacheUrl = null
}

/** For testing — reset module-level cache */
export function resetJWKSCache(): void {
  invalidateJWKSCache()
}

// --- Structural Pre-Check ---

/**
 * Structural pre-check: verifies the token looks like a JWT before attempting
 * full ES256 validation. This prevents opaque bearer tokens from being parsed.
 *
 * Returns true if the token has 3 segments and the header contains alg:ES256 + typ:JWT.
 */
export function isStructurallyJWT(token: string): boolean {
  const parts = token.split(".")
  if (parts.length !== 3) return false

  try {
    const header = decodeProtectedHeader(token)
    return header.alg === "ES256" && header.typ === "JWT"
  } catch {
    return false
  }
}

// --- JWT Validation ---

const VALID_TIERS = new Set(["free", "pro", "enterprise"])

function validateClaims(payload: Record<string, unknown>): JWTClaims {
  const required = ["iss", "aud", "sub", "tenant_id", "tier", "req_hash", "iat", "exp"]
  for (const field of required) {
    if (payload[field] === undefined || payload[field] === null) {
      throw new Error(`Missing required claim: ${field}`)
    }
  }

  if (typeof payload.tier !== "string" || !VALID_TIERS.has(payload.tier)) {
    throw new Error(`Invalid tier: ${payload.tier}`)
  }

  if (typeof payload.tenant_id !== "string" || !payload.tenant_id) {
    throw new Error("tenant_id must be a non-empty string")
  }

  if (typeof payload.req_hash !== "string") {
    throw new Error("req_hash must be a string")
  }

  if (payload.model_preferences !== undefined && payload.model_preferences !== null) {
    if (typeof payload.model_preferences !== "object" || Array.isArray(payload.model_preferences)) {
      throw new Error("model_preferences must be an object")
    }
    for (const [key, val] of Object.entries(payload.model_preferences as Record<string, unknown>)) {
      if (typeof val !== "string") {
        throw new Error(`model_preferences.${key} must be a string`)
      }
    }
  }

  return payload as unknown as JWTClaims
}

export type JWTValidationResult =
  | { ok: true; claims: JWTClaims }
  | { ok: false; error: string; code: string }

/**
 * Validate an ES256 JWT against the configured JWKS endpoint.
 * Returns validated claims on success, error details on failure.
 *
 * Validation order (security-critical):
 *   1. Structural pre-check (3 segments, ES256 header)
 *   2. Signature + standard claims (exp, nbf, iss, aud) via jose
 *   3. Custom claims validation (tenant_id, tier, req_hash)
 *   4. JTI replay check (if guard provided and jti present)
 *
 * Expired tokens are rejected at step 2 before reaching the JTI check.
 */
export async function validateJWT(
  token: string,
  config: JWTConfig,
  replayGuard?: JtiReplayGuard,
): Promise<JWTValidationResult> {
  if (!isStructurallyJWT(token)) {
    return { ok: false, error: "Not a valid JWT structure", code: "JWT_STRUCTURAL_INVALID" }
  }

  // First attempt with cached JWKS
  let jwks = getJWKS(config.jwksUrl)

  let claims: JWTClaims
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audience,
      clockTolerance: config.clockSkewSeconds,
      maxTokenAge: `${config.maxTokenLifetimeSeconds}s`,
      algorithms: ["ES256"],
    })

    claims = validateClaims(payload as Record<string, unknown>)
  } catch (firstErr) {
    // On kid miss, refetch JWKS once and retry (dual-key rotation window)
    const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)
    if (errMsg.includes("no applicable key found") || errMsg.includes("JWKSNoMatchingKey")) {
      invalidateJWKSCache()
      jwks = getJWKS(config.jwksUrl)

      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: config.issuer,
          audience: config.audience,
          clockTolerance: config.clockSkewSeconds,
          maxTokenAge: `${config.maxTokenLifetimeSeconds}s`,
          algorithms: ["ES256"],
        })

        claims = validateClaims(payload as Record<string, unknown>)
      } catch (retryErr) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr)
        return { ok: false, error: `JWT validation failed after JWKS refetch: ${msg}`, code: "JWT_INVALID" }
      }
    } else {
      return { ok: false, error: `JWT validation failed: ${errMsg}`, code: "JWT_INVALID" }
    }
  }

  // JTI replay check — runs AFTER signature + claims validation
  // Expired tokens are already rejected above (jose checks exp claim)
  if (replayGuard && claims!.jti) {
    const ttlSec = deriveJtiTtl(claims!.exp)
    const isReplay = await replayGuard.checkAndStore(claims!.jti, ttlSec)
    if (isReplay) {
      return { ok: false, error: "JTI replay detected", code: "JTI_REPLAY_DETECTED" }
    }
  }

  return { ok: true, claims: claims! }
}

// --- Hono Middleware ---

/**
 * JWT auth middleware for /api/v1/* routes.
 * Validates ES256 JWTs, extracts TenantContext onto Hono context.
 *
 * Structural pre-check: if the Authorization token doesn't look like a JWT
 * (3 segments, ES256 header), returns 401 immediately — no fallback to bearer.
 */
export function jwtAuthMiddleware(config: FinnConfig, replayGuard?: JtiReplayGuard) {
  return async (c: Context, next: Next) => {
    if (!config.jwt.enabled) {
      return next()
    }

    const authHeader = c.req.header("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized", code: "JWT_REQUIRED" }, 401)
    }

    const token = authHeader.slice(7)

    // Structural pre-check: must look like a JWT
    if (!isStructurallyJWT(token)) {
      return c.json({ error: "Unauthorized", code: "JWT_STRUCTURAL_INVALID" }, 401)
    }

    const result = await validateJWT(token, config.jwt, replayGuard)
    if (!result.ok) {
      return c.json({ error: "Unauthorized", code: result.code }, 401)
    }

    const tenantContext: TenantContext = {
      claims: result.claims,
      resolvedPools: [], // populated by pool-registry middleware downstream
      isNFTRouted: !!result.claims.nft_id,
      isBYOK: !!result.claims.byok,
    }

    c.set("tenant", tenantContext)
    c.set("jwtClaims", result.claims)
    return next()
  }
}

/**
 * Validate JWT from WebSocket upgrade request.
 * Token comes from the `token` query parameter.
 * Returns TenantContext on success, null on failure.
 */
export async function validateWsJWT(
  token: string | undefined,
  config: JWTConfig,
  replayGuard?: JtiReplayGuard,
): Promise<TenantContext | null> {
  if (!config.enabled || !token) return null

  const result = await validateJWT(token, config, replayGuard)
  if (!result.ok) return null

  return {
    claims: result.claims,
    resolvedPools: [],
    isNFTRouted: !!result.claims.nft_id,
    isBYOK: !!result.claims.byok,
  }
}

// --- req_hash Verification (T-A.3) ---

const MAX_BODY_SIZE = 1024 * 1024 // 1MB
const HASH_METHODS = new Set(["POST", "PUT", "PATCH"])
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
const REQ_HASH_REGEX = /^sha256:[0-9a-f]{64}$/

/**
 * Compute SHA-256 hex digest of a Uint8Array.
 */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

/**
 * req_hash verification middleware (SDD §3.1, T-A.3).
 *
 * Verifies the `req_hash` JWT claim matches `sha256:<hex>` of the raw request body.
 * Only applies to POST/PUT/PATCH with Content-Type: application/json.
 * WS/SSE paths skip entirely.
 *
 * Must run AFTER jwtAuthMiddleware (needs claims on context).
 * Must run BEFORE any body-parsing middleware (needs raw bytes).
 */
export function reqHashMiddleware() {
  return async (c: Context, next: Next) => {
    // Only verify on methods that have a body
    if (!HASH_METHODS.has(c.req.method)) {
      return next()
    }

    // Only verify JSON content type
    const contentType = c.req.header("Content-Type")
    if (!contentType || !contentType.includes("application/json")) {
      return next()
    }

    // Get JWT claims from context (set by jwtAuthMiddleware)
    const claims = c.get("jwtClaims") as JWTClaims | undefined
    if (!claims?.req_hash) {
      return next()
    }

    // Reject non-identity content encoding
    const contentEncoding = c.req.header("Content-Encoding")
    if (contentEncoding && contentEncoding !== "identity") {
      return c.json({ error: "req_hash_requires_identity_encoding" }, 415)
    }

    // Check Content-Length header before buffering
    const contentLength = c.req.header("Content-Length")
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
      return c.json({ error: "Request body too large", code: "BODY_TOO_LARGE" }, 413)
    }

    // Buffer raw body
    let rawBytes: Uint8Array
    try {
      const buffer = await c.req.raw.arrayBuffer()
      if (buffer.byteLength > MAX_BODY_SIZE) {
        return c.json({ error: "Request body too large", code: "BODY_TOO_LARGE" }, 413)
      }
      rawBytes = new Uint8Array(buffer)
    } catch {
      return c.json({ error: "Failed to read request body", code: "BODY_READ_FAILED" }, 400)
    }

    // Validate req_hash format before comparison
    if (!REQ_HASH_REGEX.test(claims.req_hash)) {
      return c.json({ error: "req_hash_format_invalid", code: "REQ_HASH_FORMAT" }, 400)
    }

    // Compute SHA-256 of raw bytes
    const hash = rawBytes.length === 0 ? EMPTY_SHA256 : sha256Hex(rawBytes)
    const expectedHash = `sha256:${hash}`

    // Timing-safe comparison to prevent side-channel attacks
    const expected = Buffer.from(expectedHash, "utf-8")
    const actual = Buffer.from(claims.req_hash, "utf-8")
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return c.json({ error: "req_hash_mismatch", code: "REQ_HASH_MISMATCH" }, 400)
    }

    return next()
  }
}
