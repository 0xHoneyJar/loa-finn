// src/substrate/__tests__/jwt-validator.test.ts — JWT validator + state-aware cache.
//
// Cycle-032 Sprint-1. See PRD FR-1 + SDD §4.3.

import { describe, it, expect, beforeAll } from "vitest"
import { exportSPKI, generateKeyPair, SignJWT } from "jose"
import { LicenseError } from "../types.js"
import { makeJwtValidator } from "../jwt-validator.js"

// ── Test fixtures (RS256 keypair + signer) ──────────────────────────

let publicPem: string
let signer: { kid: string; privateKey: CryptoKey }

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true })
  publicPem = await exportSPKI(publicKey)
  signer = { kid: "test-key-1", privateKey }
})

interface SignOpts {
  iss?: string
  sub?: string
  aud?: string
  iat?: number /* seconds */
  exp?: number /* seconds */
  nbf?: number /* seconds */
  tier?: string
  kid?: string
  alg?: string
}

async function signLicense(opts: SignOpts = {}): Promise<string> {
  const jwt = new SignJWT({
    tier: opts.tier ?? "pro",
    scope: "skill:load",
  })
    .setProtectedHeader({ alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? signer.kid })
    .setIssuer(opts.iss ?? "constructs.network")
    .setAudience(opts.aud ?? "loa-framework")
    .setSubject(opts.sub ?? "test-vendor/test-construct")
    .setIssuedAt(opts.iat ?? Math.floor(Date.now() / 1000) - 3600)
    .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 3600)

  if (opts.nbf !== undefined) jwt.setNotBefore(opts.nbf)
  return await jwt.sign(signer.privateKey)
}

const HOUR = 3600
const NOW_SEC = 1735689600 // 2025-01-01T00:00:00Z (deterministic)
const NOW = new Date(NOW_SEC * 1000)

function fixedClock(sec: number): () => Date {
  return () => new Date(sec * 1000)
}

// ── Tests ───────────────────────────────────────────────────────────

describe("jwt-validator", () => {
  describe("validate", () => {
    it("accepts a currently-valid license (status=valid)", async () => {
      const token = await signLicense({ exp: NOW_SEC + HOUR, iat: NOW_SEC - HOUR })
      const v = makeJwtValidator({
        publicKeyResolver: async () => publicPem,
        clock: fixedClock(NOW_SEC),
      })
      const result = await v.validate(token)
      expect(result.status).toBe("valid")
      expect(result.license.tier).toBe("pro")
      expect(result.license.kid).toBe(signer.kid)
      expect(result.license.expiresAt.getTime()).toBe((NOW_SEC + HOUR) * 1000)
    })

    it("returns validatedWithGrace for license expired within tier grace window", async () => {
      // pro tier: 24h grace
      const expSec = NOW_SEC - HOUR // expired 1h ago
      const token = await signLicense({ exp: expSec, iat: NOW_SEC - 2 * HOUR, tier: "pro" })
      const v = makeJwtValidator({
        publicKeyResolver: async () => publicPem,
        clock: fixedClock(NOW_SEC),
      })
      const result = await v.validate(token)
      expect(result.status).toBe("validatedWithGrace")
      expect(result.license.expiresAt.getTime()).toBe(expSec * 1000)
    })

    it("rejects with LicenseError when expired beyond grace", async () => {
      // pro tier: 24h grace; expire 30h ago
      const expSec = NOW_SEC - 30 * HOUR
      const token = await signLicense({ exp: expSec, iat: NOW_SEC - 31 * HOUR, tier: "pro" })
      const v = makeJwtValidator({
        publicKeyResolver: async () => publicPem,
        clock: fixedClock(NOW_SEC),
      })
      await expect(v.validate(token)).rejects.toBeInstanceOf(LicenseError)
    })

    it("rejects bad-signature with LicenseError", async () => {
      const token = await signLicense({ exp: NOW_SEC + HOUR })
      // Tamper: mutate last char of signature
      const tampered = token.slice(0, -3) + (token.slice(-3) === "AAA" ? "BBB" : "AAA")
      const v = makeJwtValidator({
        publicKeyResolver: async () => publicPem,
        clock: fixedClock(NOW_SEC),
      })
      await expect(v.validate(tampered)).rejects.toBeInstanceOf(LicenseError)
    })

    it("rejects missing kid in JWT header", async () => {
      const token = await signLicense({ exp: NOW_SEC + HOUR, kid: "" })
      const v = makeJwtValidator({
        publicKeyResolver: async () => publicPem,
        clock: fixedClock(NOW_SEC),
      })
      await expect(v.validate(token)).rejects.toThrow(/missing.*kid/i)
    })

    it("rejects wrong issuer", async () => {
      const token = await signLicense({ exp: NOW_SEC + HOUR, iss: "wrong-issuer.com" })
      const v = makeJwtValidator({
        publicKeyResolver: async () => publicPem,
        clock: fixedClock(NOW_SEC),
      })
      await expect(v.validate(token)).rejects.toBeInstanceOf(LicenseError)
    })

    it("rejects wrong tier", async () => {
      const token = await signLicense({ exp: NOW_SEC + HOUR, tier: "ultraplatinum" as never })
      const v = makeJwtValidator({
        publicKeyResolver: async () => publicPem,
        clock: fixedClock(NOW_SEC),
      })
      await expect(v.validate(token)).rejects.toThrow(/invalid tier/i)
    })

    it("respects nbf — rejects when nbf > now (signature path)", async () => {
      // jose's jwtVerify rejects nbf > now via signature path; we map to LicenseError
      const token = await signLicense({ exp: NOW_SEC + 2 * HOUR, nbf: NOW_SEC + HOUR, iat: NOW_SEC })
      const v = makeJwtValidator({
        publicKeyResolver: async () => publicPem,
        clock: fixedClock(NOW_SEC),
      })
      await expect(v.validate(token)).rejects.toBeInstanceOf(LicenseError)
    })
  })

  describe("cache + clock recheck", () => {
    it("caches valid result and re-checks exp on cached read", async () => {
      const expSec = NOW_SEC + HOUR
      const token = await signLicense({ exp: expSec, iat: NOW_SEC - HOUR })
      let nowSec = NOW_SEC
      const v = makeJwtValidator({
        publicKeyResolver: async () => publicPem,
        clock: () => new Date(nowSec * 1000),
      })

      const r1 = await v.validate(token)
      expect(r1.status).toBe("valid")
      expect(v.cacheSize()).toBe(1)

      // Advance clock 5 minutes — still well within exp + cache TTL
      nowSec += 5 * 60
      const r2 = await v.validate(token)
      expect(r2.status).toBe("valid")
      expect(v.cacheSize()).toBe(1) // same cache entry hit

      // Advance past exp — cache entry should be re-evaluated and now grace
      nowSec = expSec + 60 // 1 minute past exp
      const r3 = await v.validate(token)
      expect(r3.status).toBe("validatedWithGrace")
    })

    it("invalidate() drops cache entry", async () => {
      const token = await signLicense({ exp: NOW_SEC + HOUR })
      const v = makeJwtValidator({
        publicKeyResolver: async () => publicPem,
        clock: fixedClock(NOW_SEC),
      })
      const r = await v.validate(token)
      expect(v.cacheSize()).toBe(1)
      v.invalidate(r.license.fingerprint, r.license.kid)
      expect(v.cacheSize()).toBe(0)
    })

    it("uses tier-specific grace (enterprise = 168h)", async () => {
      // enterprise tier: 168h grace; expire 100h ago
      const expSec = NOW_SEC - 100 * HOUR
      const token = await signLicense({ exp: expSec, iat: NOW_SEC - 101 * HOUR, tier: "enterprise" })
      const v = makeJwtValidator({
        publicKeyResolver: async () => publicPem,
        clock: fixedClock(NOW_SEC),
      })
      const result = await v.validate(token)
      expect(result.status).toBe("validatedWithGrace")
    })
  })
})
