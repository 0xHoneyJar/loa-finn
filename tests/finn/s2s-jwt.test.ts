// tests/finn/s2s-jwt.test.ts — S2S JWT Signing tests (T-A.6)

import { describe, it, expect, beforeAll } from "vitest"
import { generateKeyPair, exportPKCS8, jwtVerify, compactVerify, importJWK } from "jose"
import { S2SJwtSigner } from "../../src/hounfour/s2s-jwt.js"
import type { S2SConfig } from "../../src/hounfour/s2s-jwt.js"

let testConfig: S2SConfig
let publicKey: CryptoKey

beforeAll(async () => {
  const keyPair = await generateKeyPair("ES256", { extractable: true })
  const pem = await exportPKCS8(keyPair.privateKey)
  publicKey = keyPair.publicKey as CryptoKey
  testConfig = {
    privateKeyPem: pem,
    kid: "loa-finn-v1",
    issuer: "loa-finn",
    audience: "arrakis",
  }
})

describe("S2SJwtSigner (T-A.6)", () => {
  describe("init", () => {
    it("initializes from PEM private key", async () => {
      const signer = new S2SJwtSigner(testConfig)
      expect(signer.isReady).toBe(false)
      await signer.init()
      expect(signer.isReady).toBe(true)
    })

    it("throws on invalid PEM", async () => {
      const signer = new S2SJwtSigner({ ...testConfig, privateKeyPem: "not-a-pem" })
      await expect(signer.init()).rejects.toThrow()
    })
  })

  describe("signJWT", () => {
    it("signs a JWT with correct claims", async () => {
      const signer = new S2SJwtSigner(testConfig)
      await signer.init()

      const token = await signer.signJWT({ purpose: "usage-report", report_id: "r-123" })
      const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
        issuer: "loa-finn",
        audience: "arrakis",
      })

      expect(protectedHeader.alg).toBe("ES256")
      expect(protectedHeader.typ).toBe("JWT")
      expect(protectedHeader.kid).toBe("loa-finn-v1")
      expect(payload.iss).toBe("loa-finn")
      expect(payload.aud).toBe("arrakis")
      expect(payload.purpose).toBe("usage-report")
      expect(payload.report_id).toBe("r-123")
      expect(payload.iat).toBeDefined()
      expect(payload.exp).toBeDefined()
    })

    it("respects custom expiration", async () => {
      const signer = new S2SJwtSigner(testConfig)
      await signer.init()

      const token = await signer.signJWT({}, 120)
      const { payload } = await jwtVerify(token, publicKey, {
        issuer: "loa-finn",
        audience: "arrakis",
      })

      const lifetime = payload.exp! - payload.iat!
      expect(lifetime).toBe(120)
    })

    it("throws if not initialized", async () => {
      const signer = new S2SJwtSigner(testConfig)
      await expect(signer.signJWT({})).rejects.toThrow("not initialized")
    })
  })

  describe("signJWS / signPayload", () => {
    it("signs raw bytes as JWS compact", async () => {
      const signer = new S2SJwtSigner(testConfig)
      await signer.init()

      const payload = new TextEncoder().encode('{"test":"data"}')
      const jws = await signer.signJWS(payload)

      // Verify with public key
      const { payload: verified, protectedHeader } = await compactVerify(jws, publicKey)
      expect(protectedHeader.alg).toBe("ES256")
      expect(protectedHeader.kid).toBe("loa-finn-v1")
      expect(new TextDecoder().decode(verified)).toBe('{"test":"data"}')
    })

    it("signPayload canonicalizes JSON object", async () => {
      const signer = new S2SJwtSigner(testConfig)
      await signer.init()

      const jws = await signer.signPayload({ b: 2, a: 1 })

      const { payload: verified } = await compactVerify(jws, publicKey)
      const decoded = new TextDecoder().decode(verified)
      // JSON.stringify preserves insertion order, so keys are b,a
      expect(JSON.parse(decoded)).toEqual({ b: 2, a: 1 })
    })
  })

  describe("getPublicJWK / getJWKS", () => {
    it("returns public JWK without private components", async () => {
      const signer = new S2SJwtSigner(testConfig)
      await signer.init()

      const jwk = signer.getPublicJWK()
      expect(jwk.kty).toBe("EC")
      expect(jwk.crv).toBe("P-256")
      expect(jwk.x).toBeDefined()
      expect(jwk.y).toBeDefined()
      expect(jwk.kid).toBe("loa-finn-v1")
      expect(jwk.alg).toBe("ES256")
      expect(jwk.use).toBe("sig")
      // Must NOT contain private key component
      expect(jwk.d).toBeUndefined()
    })

    it("getJWKS returns valid JWKS document", async () => {
      const signer = new S2SJwtSigner(testConfig)
      await signer.init()

      const jwks = signer.getJWKS()
      expect(jwks.keys).toHaveLength(1)
      expect(jwks.keys[0].kid).toBe("loa-finn-v1")
    })

    it("JWKS public key can verify signed JWTs", async () => {
      const signer = new S2SJwtSigner(testConfig)
      await signer.init()

      const token = await signer.signJWT({ test: true })
      const jwk = signer.getPublicJWK()
      const importedKey = await importJWK(jwk, "ES256")

      const { payload } = await jwtVerify(token, importedKey, {
        issuer: "loa-finn",
        audience: "arrakis",
      })

      expect(payload.test).toBe(true)
    })

    it("throws if not initialized", () => {
      const signer = new S2SJwtSigner(testConfig)
      expect(() => signer.getPublicJWK()).toThrow("not initialized")
    })
  })
})
