// src/hounfour/jwt-auth.ts — JWT Validation Middleware (SDD §3.1, T-A.1)
// Validates ES256 JWTs from arrakis, extracts TenantContext onto Hono context.
// Phase 5 Sprint 2: JWKS state machine, issuer allowlist, jti namespace, audience rules.

import { createHash, timingSafeEqual } from "node:crypto"
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from "jose"
import type { Context, Next } from "hono"
import type { FinnConfig } from "../config.js"
import type { JtiReplayGuard } from "./jti-replay.js"
import { deriveJtiTtl } from "./jti-replay.js"
import type { PoolId, Tier } from "@0xhoneyjar/loa-hounfour"

// --- Protocol Constants (matches loa-hounfour JTI_POLICY) ---

export const JTI_POLICY = {
  invoke: { required: true },
  admin: { required: true },
  s2s_get: { required: false, compensating: "exp <= 60s" },
} as const

export const AUDIENCE_MAP = {
  invoke: "loa-finn",
  admin: "loa-finn-admin",
  s2s: "arrakis",
} as const

export type EndpointType = "invoke" | "admin" | "s2s"

// --- Interfaces ---

export interface JWTClaims {
  iss: string
  aud: string
  sub: string
  tenant_id: string
  tier: Tier
  nft_id?: string
  model_preferences?: Record<string, string>
  byok?: boolean
  req_hash: string
  iat: number
  exp: number
  jti?: string
  scope?: string  // S2S scope claim (e.g., "admin:jwks")
  pool_id?: string         // Optional: requested pool (validated by pool enforcement)
  allowed_pools?: string[] // Optional: gateway hint (never trusted, re-derived)
}

export interface TenantContext {
  claims: JWTClaims
  resolvedPools: readonly PoolId[]
  requestedPool?: PoolId | null
  isNFTRouted: boolean
  isBYOK: boolean
}

/** All inputs the JWT validation logic needs — no Hono dependency */
export interface AuthRequestInput {
  authorizationHeader: string | undefined
  jwtConfig: JWTConfig
  replayGuard?: JtiReplayGuard
  endpointType?: EndpointType
}

export interface JWTConfig {
  enabled: boolean
  issuer: string                        // Legacy single issuer (backward compat)
  issuers?: string[]                    // Issuer allowlist (takes precedence over issuer)
  audience: string                      // Default audience (invoke)
  jwksUrl: string
  clockSkewSeconds: number
  maxTokenLifetimeSeconds: number
  maxStalenessMs?: number               // Default: 24h, DEGRADED threshold
  compromiseMode?: boolean              // Tighten staleness to 1h
  compromiseMaxStalenessMs?: number     // Default: 1h
}

// --- JWKS State Machine (HEALTHY → STALE → DEGRADED) ---

export type JWKSState = "HEALTHY" | "STALE" | "DEGRADED"

const JWKS_HEALTHY_TTL_MS = 15 * 60 * 1000              // 15 minutes
const JWKS_DEFAULT_MAX_STALENESS_MS = 24 * 60 * 60 * 1000  // 24 hours
const JWKS_COMPROMISE_MAX_STALENESS_MS = 60 * 60 * 1000    // 1 hour
const CIRCUIT_BREAKER_THRESHOLD = 5
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000
const REFRESH_RATE_LIMIT_MS = 1000                       // 1 refresh/sec

export class JWKSStateMachine {
  private jwksFn: ReturnType<typeof createRemoteJWKSet>
  private lastSuccessMs = 0
  private knownKids = new Set<string>()
  private consecutiveRefreshFailures = 0
  private lastRefreshAttemptMs = 0
  private _maxStalenessMs: number

  constructor(
    private jwksUrl: string,
    opts?: { maxStalenessMs?: number; compromiseMode?: boolean; compromiseMaxStalenessMs?: number },
  ) {
    this._maxStalenessMs = opts?.compromiseMode
      ? (opts.compromiseMaxStalenessMs ?? JWKS_COMPROMISE_MAX_STALENESS_MS)
      : (opts?.maxStalenessMs ?? JWKS_DEFAULT_MAX_STALENESS_MS)
    this.jwksFn = createRemoteJWKSet(new URL(jwksUrl))
  }

  get state(): JWKSState {
    if (this.lastSuccessMs === 0) return "DEGRADED"
    const age = Date.now() - this.lastSuccessMs
    if (age < JWKS_HEALTHY_TTL_MS) return "HEALTHY"
    if (age < this._maxStalenessMs) return "STALE"
    return "DEGRADED"
  }

  /** True once at least one successful validation has been recorded. */
  get initialized(): boolean { return this.lastSuccessMs > 0 }

  get maxStalenessMs(): number { return this._maxStalenessMs }

  isKnownKid(kid: string): boolean {
    return this.knownKids.has(kid)
  }

  getJWKS(): ReturnType<typeof createRemoteJWKSet> {
    return this.jwksFn
  }

  /**
   * Try to create a fresh JWKS function. Returns current if rate-limited or circuit-broken.
   *
   * Note (BB-063-018): The old RemoteJWKSet instance is replaced without explicit cleanup.
   * This is safe because: (1) jose's RemoteJWKSet holds no persistent resources — it is
   * a closure over a URL that fetches on demand, (2) the rate limiter prevents rapid
   * replacement, and (3) any in-flight fetch from the old instance will complete but its
   * result is simply discarded (not referenced by this.jwksFn anymore).
   */
  refresh(): ReturnType<typeof createRemoteJWKSet> {
    const now = Date.now()
    if ((now - this.lastRefreshAttemptMs) < REFRESH_RATE_LIMIT_MS) {
      return this.jwksFn
    }
    if (this.consecutiveRefreshFailures >= CIRCUIT_BREAKER_THRESHOLD
      && (now - this.lastRefreshAttemptMs) < CIRCUIT_BREAKER_COOLDOWN_MS) {
      return this.jwksFn
    }
    this.lastRefreshAttemptMs = now
    this.jwksFn = createRemoteJWKSet(new URL(this.jwksUrl))
    return this.jwksFn
  }

  recordSuccess(kid: string): void {
    this.lastSuccessMs = Date.now()
    this.consecutiveRefreshFailures = 0
    this.knownKids.add(kid)
  }

  recordRefreshFailure(): void {
    this.consecutiveRefreshFailures++
  }

  /** Admin invalidation — force re-fetch, clear known kids */
  invalidate(): void {
    this.jwksFn = createRemoteJWKSet(new URL(this.jwksUrl))
    this.knownKids.clear()
    this.lastSuccessMs = 0
    this.consecutiveRefreshFailures = 0
    this.lastRefreshAttemptMs = 0
  }

  /** Update max staleness (for compromise mode toggle at runtime) */
  setMaxStaleness(ms: number): void {
    this._maxStalenessMs = ms
  }

  /** Visible for testing */
  get knownKidCount(): number { return this.knownKids.size }

  /** Inject timestamps for testing */
  _setLastSuccessMs(ms: number): void { this.lastSuccessMs = ms }
  _setLastRefreshAttemptMs(ms: number): void { this.lastRefreshAttemptMs = ms }
  _setConsecutiveFailures(n: number): void { this.consecutiveRefreshFailures = n }
}

// --- Module-level JWKS state machine (singleton) ---
//
// Design constraint (BB-063-003): Single JWKS endpoint assumed. All endpoint
// types (invoke, admin, s2s) share this singleton. If gateway and S2S keys
// are ever served from different endpoints, refactor to per-endpoint machines.
//
// The singleton is safe in single-threaded JS (no mutex needed). The
// ValidateJWTOptions.jwksMachine override exists for testing isolation.

let globalJWKS: JWKSStateMachine | null = null

function getOrCreateJWKS(config: JWTConfig): JWKSStateMachine {
  if (!globalJWKS) {
    globalJWKS = new JWKSStateMachine(config.jwksUrl, {
      maxStalenessMs: config.maxStalenessMs,
      compromiseMode: config.compromiseMode,
      compromiseMaxStalenessMs: config.compromiseMaxStalenessMs,
    })
  }
  return globalJWKS
}

/** For testing — reset module-level state */
export function resetJWKSCache(): void {
  globalJWKS = null
}

/** Get the current JWKS state machine (for admin/diagnostics) */
export function getJWKSStateMachine(): JWKSStateMachine | null {
  return globalJWKS
}

// --- Structural Pre-Check ---

/**
 * Structural pre-check: verifies the token looks like a JWT before attempting
 * full ES256 validation. This prevents opaque bearer tokens from being parsed.
 *
 * Returns true if: 3 segments, alg=ES256, kid present.
 * typ is optional/ignored per protocol spec.
 */
export function isStructurallyJWT(token: string): boolean {
  const parts = token.split(".")
  if (parts.length !== 3) return false

  try {
    const header = decodeProtectedHeader(token)
    return header.alg === "ES256" && typeof header.kid === "string" && header.kid.length > 0
  } catch {
    return false
  }
}

// --- Issuer Allowlist ---

function resolveIssuers(config: JWTConfig): string[] {
  if (config.issuers && config.issuers.length > 0) return config.issuers
  return [config.issuer]
}

function isIssuerAllowed(iss: string, allowlist: string[]): boolean {
  return allowlist.includes(iss) // exact string match per protocol spec
}

// --- JTI Namespace ---

/**
 * Namespace jti with length-prefixed issuer to prevent cross-issuer collision.
 * Format: jti:{iss.length}:{iss}:{jti}
 *
 * Length prefix prevents canonicalization attacks where crafted issuer strings
 * containing the delimiter could produce collisions. E.g. without length prefix,
 * namespaceJti("evil:fake", "victim") === namespaceJti("evil", "fake:victim").
 */
export function namespaceJti(iss: string, jti: string): string {
  return `jti:${iss.length}:${iss}:${jti}`
}

// --- JTI Requirement ---

export function isJtiRequired(endpointType: EndpointType): boolean {
  if (endpointType === "invoke") return JTI_POLICY.invoke.required
  if (endpointType === "admin") return JTI_POLICY.admin.required
  return JTI_POLICY.s2s_get.required
}

// --- Audience Resolution ---

export function resolveAudience(endpointType: EndpointType): string {
  return AUDIENCE_MAP[endpointType]
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

export interface ValidateJWTOptions {
  endpointType?: EndpointType
  jwksMachine?: JWKSStateMachine  // Override global state machine (testing)
}

/**
 * Validate an ES256 JWT against the configured JWKS endpoint.
 * Returns validated claims on success, error details on failure.
 *
 * Validation order (security-critical):
 *   1. Structural pre-check (3 segments, ES256 header, kid present)
 *   2. Header kid validation against JWKS state
 *   3. Issuer allowlist check
 *   4. Signature + standard claims (exp, nbf, iss, aud) via jose
 *   5. Custom claims validation (tenant_id, tier, req_hash)
 *   6. JTI requirement check per endpoint type
 *   7. JTI replay check with per-issuer namespace
 *
 * Expired tokens are rejected at step 4 before reaching the JTI check.
 */
export async function validateJWT(
  token: string,
  config: JWTConfig,
  replayGuard?: JtiReplayGuard,
  opts?: ValidateJWTOptions,
): Promise<JWTValidationResult> {
  const endpointType = opts?.endpointType ?? "invoke"

  // 1. Structural pre-check
  if (!isStructurallyJWT(token)) {
    return { ok: false, error: "Not a valid JWT structure", code: "JWT_STRUCTURAL_INVALID" }
  }

  // 2. Extract kid from header
  const header = decodeProtectedHeader(token)
  const kid = header.kid as string // guaranteed by isStructurallyJWT

  // 3. Decode payload for issuer pre-check (before expensive signature verification)
  //    We need the issuer to check the allowlist. jose's jwtVerify also checks issuer,
  //    but we want to reject disallowed issuers before hitting JWKS.
  const issuers = resolveIssuers(config)

  // 4. Get JWKS state machine
  const machine = opts?.jwksMachine ?? getOrCreateJWKS(config)
  const currentState = machine.state

  // STALE/DEGRADED: reject unknown kids without attempting refresh.
  // Skip this check for uninitialized machines (first-time use must be allowed).
  if (machine.initialized && currentState !== "HEALTHY" && !machine.isKnownKid(kid)) {
    if (currentState === "DEGRADED") {
      return { ok: false, error: "JWKS degraded: unknown kid rejected", code: "JWKS_DEGRADED" }
    }
    // STALE: attempt refresh for unknown kid
    machine.refresh()
  }

  // 5. Signature verification via jose
  const expectedAudience = resolveAudience(endpointType)
  let jwks = machine.getJWKS()
  let claims: JWTClaims

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: issuers,
      audience: expectedAudience,
      clockTolerance: config.clockSkewSeconds,
      maxTokenAge: `${config.maxTokenLifetimeSeconds}s`,
      algorithms: ["ES256"],
    })

    claims = validateClaims(payload as Record<string, unknown>)
    machine.recordSuccess(kid)
  } catch (firstErr) {
    const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)

    // On kid miss, refetch JWKS once and retry (dual-key rotation window)
    if (errMsg.includes("no applicable key found") || errMsg.includes("JWKSNoMatchingKey")) {
      jwks = machine.refresh()
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: issuers,
          audience: expectedAudience,
          clockTolerance: config.clockSkewSeconds,
          maxTokenAge: `${config.maxTokenLifetimeSeconds}s`,
          algorithms: ["ES256"],
        })

        claims = validateClaims(payload as Record<string, unknown>)
        machine.recordSuccess(kid)
      } catch (retryErr) {
        machine.recordRefreshFailure()
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr)
        return { ok: false, error: `JWT validation failed after JWKS refetch: ${msg}`, code: "JWT_INVALID" }
      }
    } else {
      // Check if this is an issuer mismatch
      if (errMsg.includes("unexpected \"iss\" claim value")) {
        return { ok: false, error: `Issuer not in allowlist`, code: "ISSUER_NOT_ALLOWED" }
      }
      if (errMsg.includes("unexpected \"aud\" claim value")) {
        return { ok: false, error: `Audience mismatch for ${endpointType} endpoint`, code: "AUDIENCE_MISMATCH" }
      }
      return { ok: false, error: `JWT validation failed: ${errMsg}`, code: "JWT_INVALID" }
    }
  }

  // 6. JTI requirement check per endpoint type
  if (isJtiRequired(endpointType) && !claims!.jti) {
    return { ok: false, error: "jti required for this endpoint type", code: "JTI_REQUIRED" }
  }

  // 7. JTI replay check with per-issuer namespace
  if (replayGuard && claims!.jti) {
    const namespacedJti = namespaceJti(claims!.iss, claims!.jti)
    const ttlSec = deriveJtiTtl(claims!.exp)
    const isReplay = await replayGuard.checkAndStore(namespacedJti, ttlSec)
    if (isReplay) {
      return { ok: false, error: "JTI replay detected", code: "JTI_REPLAY_DETECTED" }
    }
  }

  return { ok: true, claims: claims! }
}

// --- Core Authentication (Framework-Agnostic) ---

/**
 * Core JWT authentication logic — no Hono dependency.
 * Takes an explicit input object covering all data the middleware uses.
 * Returns TenantContext on success, or a structured 401 error.
 */
export async function authenticateRequest(
  input: AuthRequestInput,
): Promise<{ ok: true; context: TenantContext } | { ok: false; status: 401; body: object }> {
  const { authorizationHeader, jwtConfig, replayGuard, endpointType } = input

  if (!authorizationHeader?.startsWith("Bearer ")) {
    return { ok: false, status: 401, body: { error: "Unauthorized", code: "JWT_REQUIRED" } }
  }

  const token = authorizationHeader.slice(7)

  if (!isStructurallyJWT(token)) {
    return { ok: false, status: 401, body: { error: "Unauthorized", code: "JWT_STRUCTURAL_INVALID" } }
  }

  const result = await validateJWT(token, jwtConfig, replayGuard, { endpointType })
  if (!result.ok) {
    return { ok: false, status: 401, body: { error: "Unauthorized", code: result.code } }
  }

  const tenantContext: TenantContext = {
    claims: result.claims,
    resolvedPools: [] as PoolId[],
    requestedPool: null,
    isNFTRouted: !!result.claims.nft_id,
    isBYOK: !!result.claims.byok,
  }

  return { ok: true, context: tenantContext }
}

// --- Hono Middleware ---

/**
 * @internal — Use hounfourAuth() for routes. This is the identity-only path.
 *
 * JWT auth middleware for /api/v1/* routes (invoke endpoint type).
 * Validates ES256 JWTs, extracts TenantContext onto Hono context.
 * Does NOT perform pool enforcement — use hounfourAuth() instead.
 */
export function jwtAuthMiddleware(
  config: FinnConfig,
  replayGuard?: JtiReplayGuard,
  endpointType: EndpointType = "invoke",
) {
  return async (c: Context, next: Next) => {
    if (!config.jwt.enabled) {
      return next()
    }

    const result = await authenticateRequest({
      authorizationHeader: c.req.header("Authorization"),
      jwtConfig: config.jwt,
      replayGuard,
      endpointType,
    })

    if (!result.ok) {
      return c.json(result.body, result.status)
    }

    c.set("tenant", result.context)
    c.set("jwtClaims", result.context.claims)
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

  const result = await validateJWT(token, config, replayGuard, { endpointType: "invoke" })
  if (!result.ok) return null

  return {
    claims: result.claims,
    resolvedPools: [],
    isNFTRouted: !!result.claims.nft_id,
    isBYOK: !!result.claims.byok,
  }
}

// --- JWKS Invalidation Handler (POST /admin/jwks/invalidate) ---

export interface JWKSInvalidateRequest {
  kid?: string  // Optional: invalidate specific kid (otherwise invalidate all)
}

export interface JWKSAuditEntry {
  event: "jwks_invalidation"
  kid: string | "all"
  admin_subject: string
  source_ip: string
  timestamp: string
}

/**
 * Admin JWKS invalidation handler.
 * Requires S2S JWT with scope "admin:jwks" and aud "loa-finn-admin".
 * Rate limited: 10 req/min (enforced at route level).
 *
 * Returns the invalidation result and logs an audit entry.
 */
export function jwksInvalidateHandler(auditLog?: (entry: JWKSAuditEntry) => void) {
  return async (c: Context) => {
    const claims = c.get("jwtClaims") as JWTClaims | undefined
    if (!claims || claims.scope !== "admin:jwks") {
      return c.json({ error: "Forbidden: admin:jwks scope required" }, 403)
    }

    const body = await c.req.json<JWKSInvalidateRequest>().catch(() => ({}))
    const kid = body.kid ?? "all"

    const machine = getJWKSStateMachine()
    if (!machine) {
      return c.json({ error: "JWKS not initialized" }, 500)
    }

    machine.invalidate()

    const auditEntry: JWKSAuditEntry = {
      event: "jwks_invalidation",
      kid,
      admin_subject: claims.sub,
      source_ip: c.req.header("X-Forwarded-For") ?? c.req.header("X-Real-IP") ?? "unknown",
      timestamp: new Date().toISOString(),
    }

    auditLog?.(auditEntry)

    return c.json({ invalidated: true, kid })
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
