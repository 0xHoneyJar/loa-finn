// src/substrate/jwt-validator.ts — RS256 JWT license validator with state-aware cache.
//
// Cycle-032 Sprint-1 Task 1.3. See PRD FR-1 + SDD §4.3.
//
// JWT payload shape (per loa-constructs/.claude/protocols/constructs-integration.md):
//   { iss, sub, aud, iat, exp, [nbf], scope, tier, [features] }
// JWT header: { alg: "RS256", typ: "JWT", kid }
//
// State-aware cache contract:
//   - valid: cache TTL = min(exp - now, 1h)
//   - validatedWithGrace: cache TTL = min((exp + grace) - now, 1h)
//   - expired-beyond-grace / not-yet-valid: NOT cached
//   - On every cached read: re-check exp + nbf against current clock
//   - LOA_OFFLINE=1: skip publicKeyResolver call; use cached key only

import { createHash } from "node:crypto"
import { compactVerify, decodeProtectedHeader, importSPKI, jwtVerify, type JWTPayload } from "jose"
import { LicenseError, TIER_GRACE_SECONDS, type LicenseTier, type ValidatedLicense, type ValidationStatus } from "./types.js"

// ── Public surface (per PRD FR-1 + SDD §4.3) ────────────────────────

export interface ValidationResult {
  status: ValidationStatus
  license: ValidatedLicense
}

export interface JwtValidator {
  validate(licenseJwt: string): Promise<ValidationResult>
  invalidate(fingerprint: string, kid: string): void
  /** Visible for tests: number of entries in the validation cache. */
  cacheSize(): number
}

export interface JwtValidatorOptions {
  /** Resolves a public key (PEM) for a given `kid`. May throw if offline + uncached. */
  publicKeyResolver: (kid: string) => Promise<string>
  /** Injectable clock — defaults to `() => new Date()`. Tests inject fake clocks. */
  clock?: () => Date
  /** Per-tier grace seconds. Defaults to cycle-1 contract values. */
  tierGracePeriods?: Record<LicenseTier, number>
  /** Maximum cache TTL regardless of exp. Default 1 hour. */
  maxCacheTtlMs?: number
  /** Expected `iss` claim. Default `"constructs.network"`. */
  expectedIssuer?: string
  /** Expected `aud` claim. Default `"loa-framework"`. */
  expectedAudience?: string
}

// ── Cache entry ──────────────────────────────────────────────────────

interface CacheEntry {
  result: ValidationResult
  /** Wall-clock time when this entry expires (ms since epoch). */
  cacheExpiresAtMs: number
}

// ── Implementation ───────────────────────────────────────────────────

export function makeJwtValidator(opts: JwtValidatorOptions): JwtValidator {
  const clock = opts.clock ?? (() => new Date())
  const grace = opts.tierGracePeriods ?? TIER_GRACE_SECONDS
  const maxCacheTtlMs = opts.maxCacheTtlMs ?? 60 * 60 * 1000 // 1h
  const expectedIssuer = opts.expectedIssuer ?? "constructs.network"
  const expectedAudience = opts.expectedAudience ?? "loa-framework"

  const cache = new Map<string, CacheEntry>()

  function cacheKey(fingerprint: string, kid: string): string {
    return `${fingerprint}::${kid}`
  }

  async function validate(licenseJwt: string): Promise<ValidationResult> {
    const fingerprint = sha256Hex(licenseJwt)

    // Decode header to extract kid (no verification yet)
    let header: ReturnType<typeof decodeProtectedHeader>
    try {
      header = decodeProtectedHeader(licenseJwt)
    } catch (cause) {
      throw new LicenseError("malformed JWT header", cause)
    }

    const kid = typeof header.kid === "string" ? header.kid : ""
    if (!kid) {
      throw new LicenseError("missing `kid` in JWT header")
    }
    if (header.alg !== "RS256") {
      throw new LicenseError(`unsupported alg "${header.alg}"; expected RS256`)
    }

    const key = cacheKey(fingerprint, kid)
    const now = clock()

    // Cached path — re-check exp + nbf even on cache hit
    const cached = cache.get(key)
    if (cached) {
      if (now.getTime() < cached.cacheExpiresAtMs) {
        const recheck = recheckLicense(cached.result.license, now, grace)
        if (recheck.status !== "rejected") {
          // F9: cached.result.license.status is informational-as-of-cache-write;
          // callers must use the recheck-derived status returned here, never
          // reach into cache.get(...).result.license.status directly.
          return { status: recheck.status, license: { ...cached.result.license, status: recheck.status } }
        }
        // recheck rejected → drop cache entry, fall through to full re-validation
        cache.delete(key)
      } else {
        cache.delete(key)
      }
    }

    // Resolve public key (may throw in offline mode if uncached upstream)
    let publicKeyPem: string
    try {
      publicKeyPem = await opts.publicKeyResolver(kid)
    } catch (cause) {
      throw new LicenseError(`cannot resolve public key for kid="${kid}"`, cause)
    }

    let publicKey: Awaited<ReturnType<typeof importSPKI>>
    try {
      publicKey = await importSPKI(publicKeyPem, "RS256")
    } catch (cause) {
      throw new LicenseError(`malformed public key for kid="${kid}"`, cause)
    }

    // Verify signature WITHOUT exp checks (we want to surface grace-period state ourselves)
    let payload: JWTPayload
    try {
      const verified = await jwtVerify(licenseJwt, publicKey, {
        issuer: expectedIssuer,
        audience: expectedAudience,
        clockTolerance: 0,
        currentDate: now,
      })
      payload = verified.payload
    } catch (cause) {
      // jose throws JWTExpired when exp is past. We want to enter the grace
      // flow ourselves rather than reject outright, so re-attempt by manually
      // verifying signature + iss/aud + nbf (NOT exp). If the cause was nbf
      // or anything else (bad sig, wrong iss/aud), the fallback returns null
      // and we propagate as LicenseError.
      const manual = await verifySignatureOnly(licenseJwt, publicKey, expectedIssuer, expectedAudience, now)
      if (!manual) {
        throw new LicenseError("signature verification failed", cause)
      }
      payload = manual
    }

    const tier = payload.tier as LicenseTier | undefined
    if (!tier || !(tier in grace)) {
      throw new LicenseError(`invalid tier "${String(payload.tier)}"; expected one of ${Object.keys(grace).join(", ")}`)
    }
    if (typeof payload.exp !== "number") {
      throw new LicenseError("missing `exp` claim")
    }

    const expMs = payload.exp * 1000
    const iatMs = typeof payload.iat === "number" ? payload.iat * 1000 : now.getTime()
    const graceMs = grace[tier] * 1000

    const license: ValidatedLicense = {
      fingerprint,
      kid,
      issuedAt: new Date(iatMs),
      expiresAt: new Date(expMs),
      graceUntil: new Date(expMs + graceMs),
      tier,
      status: "valid", // refined below
    }

    const recheck = recheckLicense(license, now, grace)
    if (recheck.status === "rejected") {
      throw new LicenseError(recheck.reason)
    }

    license.status = recheck.status

    const result: ValidationResult = { status: recheck.status, license }

    // Cache TTL strategy per PRD FR-1
    let ttlMs: number
    if (recheck.status === "valid") {
      ttlMs = Math.min(expMs - now.getTime(), maxCacheTtlMs)
    } else {
      // validatedWithGrace
      ttlMs = Math.min(expMs + graceMs - now.getTime(), maxCacheTtlMs)
    }
    if (ttlMs > 0) {
      cache.set(key, { result, cacheExpiresAtMs: now.getTime() + ttlMs })
    }

    return result
  }

  function invalidate(fingerprint: string, kid: string): void {
    cache.delete(cacheKey(fingerprint, kid))
  }

  function cacheSize(): number {
    return cache.size
  }

  return { validate, invalidate, cacheSize }
}

// ── Helpers ──────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

type RecheckResult =
  | { status: "valid" }
  | { status: "validatedWithGrace" }
  | { status: "rejected"; reason: string }

function recheckLicense(license: ValidatedLicense, now: Date, grace: Record<LicenseTier, number>): RecheckResult {
  const nowMs = now.getTime()

  if (license.expiresAt.getTime() > nowMs) {
    return { status: "valid" }
  }

  const expMs = license.expiresAt.getTime()
  const graceMs = grace[license.tier] * 1000
  if (nowMs < expMs + graceMs) {
    return { status: "validatedWithGrace" }
  }

  return { status: "rejected", reason: `expired beyond grace period (tier=${license.tier})` }
}

/**
 * Verify the JWT signature + iss/aud + nbf claims, but NOT exp.
 * Returns parsed payload on success, null on failure (including nbf > now).
 *
 * Used when a token is signature-valid but past `exp` — we want to enter the
 * grace-period flow rather than reject outright. nbf must still gate access:
 * a future-issued token cannot be served via the grace path.
 */
async function verifySignatureOnly(
  token: string,
  publicKey: Awaited<ReturnType<typeof importSPKI>>,
  expectedIssuer: string,
  expectedAudience: string,
  now: Date,
): Promise<JWTPayload | null> {
  try {
    // Bridgebuilder iter-6 HIGH fix: verify signature FIRST before any
    // claim inspection. Previous ordering (claim checks → signature) was
    // safe-by-accident — a future refactor adding early-return logic
    // between the claim checks and compactVerify could introduce a
    // verify-then-use ordering bug. Now: signature established first,
    // then payload extracted from the verified token.
    //
    // Bridgebuilder iter-1 F10 fix: act on the EXACT payload bytes that
    // compactVerify validated, not a separately-parsed copy. Eliminates
    // the verify-here-act-there parse-differential surface (OWASP JWT
    // cheat sheet; SAML XML signature wrapping family).
    const { payload: payloadBytes } = await compactVerify(token, publicKey)
    const payloadJson = new TextDecoder().decode(payloadBytes)
    const parsed: unknown = JSON.parse(payloadJson)

    // Bridgebuilder iter-4 Medium fix: explicit structural validation.
    if (parsed === null || typeof parsed !== "object") return null
    const payload = parsed as JWTPayload
    if (typeof payload.iss !== "string") return null
    if (typeof payload.exp !== "number") return null
    // Bridgebuilder iter-6 Medium fix: explicit aud-presence check (was
    // safe-by-accident via undefined !== expected; now explicit).
    if (payload.aud === undefined) return null

    // Verify iss/aud match (signature already verified above)
    if (payload.iss !== expectedIssuer) return null
    if (Array.isArray(payload.aud) ? !payload.aud.includes(expectedAudience) : payload.aud !== expectedAudience) {
      return null
    }

    // Verify nbf (not yet valid) — reject if license isn't active yet
    const nowSec = Math.floor(now.getTime() / 1000)
    if (typeof payload.nbf === "number" && payload.nbf > nowSec) return null

    return payload
  } catch {
    return null
  }
}
