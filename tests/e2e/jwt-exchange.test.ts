// tests/e2e/jwt-exchange.test.ts — JWT Exchange E2E (cycle-035 T-3.4)
//
// Verifies Finn JWKS and S2S JWT shape. Cross-service Freeside/Dixie checks
// run only when their URLs are explicitly provided by the harness.

import { describe, it, expect, beforeAll } from "vitest"
import { importPKCS8, SignJWT, jwtVerify, createLocalJWKSet } from "jose"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const FINN_URL = process.env.E2E_FINN_URL ?? process.env.FINN_URL ?? "http://localhost:3001"
const FREESIDE_URL = process.env.E2E_FREESIDE_URL
const DIXIE_URL = process.env.E2E_DIXIE_URL

const KEYS_DIR = resolve(import.meta.dirname ?? __dirname, "keys")

function loadPem(name: string): string {
  return readFileSync(resolve(KEYS_DIR, `${name}.pem`), "utf-8")
}

describe("E2E: JWT Exchange", () => {
  let finnPrivateKey: CryptoKey
  let adminPrivateKey: CryptoKey

  beforeAll(async () => {
    finnPrivateKey = await importPKCS8(loadPem("finn-private"), "ES256") as CryptoKey
    adminPrivateKey = await importPKCS8(loadPem("admin-private"), "ES256") as CryptoKey
  })

  describe("finn JWKS endpoint", () => {
    it("serves /.well-known/jwks.json with ES256 public key", async () => {
      const res = await fetch(`${FINN_URL}/.well-known/jwks.json`)
      expect(res.status).toBe(200)

      const jwks = await res.json() as { keys: Array<Record<string, unknown>> }
      expect(jwks.keys).toBeDefined()
      expect(jwks.keys.length).toBeGreaterThan(0)

      const key = jwks.keys[0]
      expect(key.kty).toBe("EC")
      expect(key.crv).toBe("P-256")
      expect(key.alg).toBe("ES256")
      expect(key.kid).toBeDefined()
      expect(key.use).toBe("sig")
      expect(key.d).toBeUndefined()
    })
  })

  describe("finn → freeside (billing JWT)", () => {
    it("finn-signed JWT has valid structure and Freeside is checked only when configured", async () => {
      const token = await new SignJWT({
        sub: "billing-request",
        wallet: "0xdeadbeef",
        amount: "1000",
      })
        .setProtectedHeader({ alg: "ES256", kid: "e2e-v1", typ: "JWT" })
        .setIssuer("e2e-harness")
        .setAudience("arrakis")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(finnPrivateKey)

      const parts = token.split(".")
      expect(parts.length).toBe(3)
      expect(parts.every(p => p.length > 0)).toBe(true)

      if (!FREESIDE_URL) {
        return
      }

      const healthRes = await fetch(`${FREESIDE_URL}/v1/health`)
      expect(healthRes.status).toBe(200)
    })
  })

  describe("finn → dixie (reputation query)", () => {
    it("finn can query dixie reputation endpoint when configured", async () => {
      if (!DIXIE_URL) {
        return
      }

      const res = await fetch(`${DIXIE_URL}/reputation/nft-test-001`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      })

      expect([200, 404]).toContain(res.status)
    })

    it("finn-signed JWT can be verified against finn JWKS", async () => {
      const token = await new SignJWT({
        sub: "reputation-query",
        nftId: "nft-test-001",
      })
        .setProtectedHeader({ alg: "ES256", kid: "e2e-v1", typ: "JWT" })
        .setIssuer("e2e-harness")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(finnPrivateKey)

      const jwksRes = await fetch(`${FINN_URL}/.well-known/jwks.json`)
      const jwks = await jwksRes.json() as { keys: Array<Record<string, unknown>> }

      const keySet = createLocalJWKSet(jwks as any)
      const { payload } = await jwtVerify(token, keySet, {
        issuer: "e2e-harness",
      })

      expect(payload.sub).toBe("reputation-query")
      expect(payload.nftId).toBe("nft-test-001")
    })
  })

  describe("admin JWT auth (admin → finn)", () => {
    it("admin-signed JWT authenticates against /admin/mode", async () => {
      const token = await new SignJWT({
        sub: "e2e-admin",
        role: "operator",
      })
        .setProtectedHeader({ alg: "ES256", kid: "admin-e2e-v1" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(adminPrivateKey)

      const res = await fetch(`${FINN_URL}/api/v1/admin/mode`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      expect([200, 503]).toContain(res.status)

      if (res.status === 200) {
        const body = await res.json() as { mode: string }
        expect(body.mode).toBeDefined()
        expect(["shadow", "enabled", "disabled"]).toContain(body.mode)
      }
    })

    it("rejects JWT with wrong role", async () => {
      const token = await new SignJWT({
        sub: "e2e-viewer",
        role: "viewer",
      })
        .setProtectedHeader({ alg: "ES256", kid: "admin-e2e-v1" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(adminPrivateKey)

      const res = await fetch(`${FINN_URL}/api/v1/admin/mode`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      expect([403, 503]).toContain(res.status)
    })
  })

  describe("cross-service JWT verification", () => {
    it("JWT round-trip: sign with finn key, verify with finn JWKS", async () => {
      const claims = {
        sub: "s2s-roundtrip",
        action: "billing_finalize",
        billingEntryId: "be_e2e_001",
        amount: "5000",
      }

      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: "e2e-v1", typ: "JWT" })
        .setIssuer("e2e-harness")
        .setAudience("arrakis")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(finnPrivateKey)

      const jwksRes = await fetch(`${FINN_URL}/.well-known/jwks.json`)
      const jwks = await jwksRes.json() as { keys: Array<Record<string, unknown>> }
      const keySet = createLocalJWKSet(jwks as any)

      const { payload } = await jwtVerify(token, keySet, {
        issuer: "e2e-harness",
        audience: "arrakis",
      })

      expect(payload.sub).toBe("s2s-roundtrip")
      expect(payload.action).toBe("billing_finalize")
      expect(payload.billingEntryId).toBe("be_e2e_001")
    })
  })
})
