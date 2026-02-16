// tests/finn/s2s-jwt.test.ts — S2S JWT Signing tests (T-A.6 + Sprint B T1)

import { describe, it, expect, beforeAll } from "vitest"
import { generateKeyPair, exportPKCS8, jwtVerify, compactVerify, importJWK, decodeProtectedHeader } from "jose"
import { S2SJwtSigner } from "../../src/hounfour/s2s-jwt.js"
import type { S2SConfigES256, S2SConfigHS256 } from "../../src/hounfour/s2s-jwt.js"

let es256Config: S2SConfigES256
let publicKey: CryptoKey

beforeAll(async () => {
  const keyPair = await generateKeyPair("ES256", { extractable: true })
  const pem = await exportPKCS8(keyPair.privateKey)
  publicKey = keyPair.publicKey as CryptoKey
  es256Config = {
    alg: "ES256",
    privateKeyPem: pem,
    kid: "loa-finn-v1",
    issuer: "loa-finn",
    audience: "arrakis",
  }
})

describe("S2SJwtSigner — ES256 (existing behavior)", () => {
  describe("init", () => {
    it("initializes from PEM private key", async () => {
      const signer = new S2SJwtSigner(es256Config)
      expect(signer.isReady).toBe(false)
      await signer.init()
      expect(signer.isReady).toBe(true)
    })

    it("throws on invalid PEM", async () => {
      const signer = new S2SJwtSigner({ ...es256Config, privateKeyPem: "not-a-pem" })
      await expect(signer.init()).rejects.toThrow()
    })
  })

  describe("signJWT", () => {
    it("signs a JWT with correct claims", async () => {
      const signer = new S2SJwtSigner(es256Config)
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

    it("default TTL is 300s", async () => {
      const signer = new S2SJwtSigner(es256Config)
      await signer.init()

      const token = await signer.signJWT({})
      const { payload } = await jwtVerify(token, publicKey, {
        issuer: "loa-finn",
        audience: "arrakis",
      })

      const lifetime = payload.exp! - payload.iat!
      expect(lifetime).toBe(300)
    })

    it("respects custom expiration", async () => {
      const signer = new S2SJwtSigner(es256Config)
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
      const signer = new S2SJwtSigner(es256Config)
      await expect(signer.signJWT({})).rejects.toThrow("not initialized")
    })
  })

  describe("signJWS / signPayload", () => {
    it("signs raw bytes as JWS compact", async () => {
      const signer = new S2SJwtSigner(es256Config)
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
      const signer = new S2SJwtSigner(es256Config)
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
      const signer = new S2SJwtSigner(es256Config)
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
      const signer = new S2SJwtSigner(es256Config)
      await signer.init()

      const jwks = signer.getJWKS()
      expect(jwks.keys).toHaveLength(1)
      expect(jwks.keys[0].kid).toBe("loa-finn-v1")
    })

    it("JWKS public key can verify signed JWTs", async () => {
      const signer = new S2SJwtSigner(es256Config)
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
      const signer = new S2SJwtSigner(es256Config)
      expect(() => signer.getPublicJWK()).toThrow("not initialized")
    })
  })
})

describe("S2SJwtSigner — HS256 (Sprint B T1)", () => {
  const hs256Config: S2SConfigHS256 = {
    alg: "HS256",
    secret: "test-shared-secret-for-billing-integration",
    issuer: "loa-finn",
    audience: "arrakis",
  }

  describe("init + signJWT round-trip", () => {
    it("initializes and produces verifiable JWT", async () => {
      const signer = new S2SJwtSigner(hs256Config)
      expect(signer.isReady).toBe(false)
      await signer.init()
      expect(signer.isReady).toBe(true)

      const token = await signer.signJWT({ purpose: "billing_finalize", reservation_id: "res-001" })

      // Verify with the same shared secret (simulating arrakis verification)
      const secret = new TextEncoder().encode(hs256Config.secret)
      const { payload, protectedHeader } = await jwtVerify(token, secret, {
        issuer: "loa-finn",
        audience: "arrakis",
        algorithms: ["HS256"],  // arrakis pins algorithm
      })

      expect(protectedHeader.alg).toBe("HS256")
      expect(payload.iss).toBe("loa-finn")
      expect(payload.aud).toBe("arrakis")
      expect(payload.purpose).toBe("billing_finalize")
      expect(payload.reservation_id).toBe("res-001")
    })
  })

  describe("algorithm from config, not header", () => {
    it("HS256 token header uses alg from config", async () => {
      const signer = new S2SJwtSigner(hs256Config)
      await signer.init()

      const token = await signer.signJWT({})
      const header = decodeProtectedHeader(token)
      expect(header.alg).toBe("HS256")
    })

    it("ES256 token header uses alg from config", async () => {
      const signer = new S2SJwtSigner(es256Config)
      await signer.init()

      const token = await signer.signJWT({})
      const header = decodeProtectedHeader(token)
      expect(header.alg).toBe("ES256")
    })
  })

  describe("kid omitted for HS256", () => {
    it("HS256 token has no kid header", async () => {
      const signer = new S2SJwtSigner(hs256Config)
      await signer.init()

      const token = await signer.signJWT({})
      const header = decodeProtectedHeader(token)
      expect(header.kid).toBeUndefined()
    })

    it("ES256 token has kid header", async () => {
      const signer = new S2SJwtSigner(es256Config)
      await signer.init()

      const token = await signer.signJWT({})
      const header = decodeProtectedHeader(token)
      expect(header.kid).toBe("loa-finn-v1")
    })
  })

  describe("default TTL is 300s", () => {
    it("HS256 default TTL is 300s", async () => {
      const signer = new S2SJwtSigner(hs256Config)
      await signer.init()

      const token = await signer.signJWT({})
      const secret = new TextEncoder().encode(hs256Config.secret)
      const { payload } = await jwtVerify(token, secret, {
        issuer: "loa-finn",
        audience: "arrakis",
      })

      const lifetime = payload.exp! - payload.iat!
      expect(lifetime).toBe(300)
    })
  })

  describe("signJWS throws for HS256", () => {
    it("signJWS throws", async () => {
      const signer = new S2SJwtSigner(hs256Config)
      await signer.init()

      const payload = new TextEncoder().encode('{"test":"data"}')
      await expect(signer.signJWS(payload)).rejects.toThrow("not supported for HS256")
    })

    it("signPayload throws (delegates to signJWS)", async () => {
      const signer = new S2SJwtSigner(hs256Config)
      await signer.init()

      await expect(signer.signPayload({ test: true })).rejects.toThrow("not supported for HS256")
    })
  })

  describe("getJWKS returns empty for HS256", () => {
    it("returns { keys: [] }", async () => {
      const signer = new S2SJwtSigner(hs256Config)
      await signer.init()

      const jwks = signer.getJWKS()
      expect(jwks.keys).toEqual([])
    })
  })

  describe("getPublicJWK throws for HS256", () => {
    it("throws", async () => {
      const signer = new S2SJwtSigner(hs256Config)
      await signer.init()

      expect(() => signer.getPublicJWK()).toThrow("not supported for HS256")
    })
  })
})
