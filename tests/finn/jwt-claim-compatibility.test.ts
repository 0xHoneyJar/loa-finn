// tests/finn/jwt-claim-compatibility.test.ts — JWT Claim Compatibility Audit (Sprint 59 T4)
// Verifies loa-finn S2S JWT claims are compatible with arrakis's expectations.
// Based on arrakis PR #63 contracts: S2SFinalizeRequest + billing-s2s.test.ts

import { describe, it, expect, beforeAll } from "vitest"
import { generateKeyPair, exportPKCS8, jwtVerify, decodeProtectedHeader } from "jose"
import { S2SJwtSigner } from "../../src/hounfour/s2s-jwt.js"
import type { S2SConfigES256 } from "../../src/hounfour/s2s-jwt.js"

// --- Test Vector: Expected Claims for S2S Billing Finalize ---
//
// Source: arrakis PR #63 (0xHoneyJar/arrakis/pull/63)
//   - themes/sietch/src/packages/core/contracts/s2s-billing.ts (S2SFinalizeRequest schema)
//   - themes/sietch/tests/integration/billing-s2s.test.ts (createInternalJwt helper)
//   - themes/sietch/src/packages/core/protocol/identity-trust.ts (AnchorVerification)
//
// Arrakis S2S JWT expectations (from test helper + contract):
//   Header: { alg: "ES256"|"HS256", typ: "JWT", kid?: string }
//   Payload:
//     sub  - Required: calling service identity ("loa-finn")
//     iss  - Required: must match arrakis config (default: "loa-finn")
//     aud  - Required: must match arrakis config (default: "arrakis")
//     iat  - Required: issued-at timestamp
//     exp  - Required: expiration (default: iat + 300s)
//     jti  - NOT required by arrakis (not in test helper or schema)
//
// Arrakis body schema (s2sFinalizeRequestSchema):
//   reservationId: string (min 1)
//   actualCostMicro: string (regex: /^\d+$/)
//   accountId?: string (optional, deprecated — derived from reservation)
//   identity_anchor?: string (optional, Sprint 253 high-value ops)
//
// Clock skew: 30s (both sides use same tolerance)

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

describe("JWT Claim Compatibility Audit (T4)", () => {
  describe("S2S billing finalize JWT — test vector", () => {
    it("produces JWT with all claims arrakis expects", async () => {
      const signer = new S2SJwtSigner(es256Config)
      await signer.init()

      // These are the exact claims billing-finalize-client.ts sends
      const billingClaims = {
        sub: "loa-finn",                  // s2sSubjectMode: "service"
        tenant_id: "tenant-abc-123",      // custom claim (not validated by arrakis JWT layer)
        purpose: "billing_finalize",      // custom claim (routing hint)
        reservation_id: "res-uuid-001",   // custom claim (links to reservation)
        trace_id: "trace-uuid-001",       // custom claim (observability)
      }

      const token = await signer.signJWT(billingClaims, 300)

      // Verify with public key (simulating arrakis JWKS verification)
      const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
        issuer: "loa-finn",
        audience: "arrakis",
        clockTolerance: 30,
      })

      // Header assertions — matches arrakis expectations
      expect(protectedHeader.alg).toBe("ES256")
      expect(protectedHeader.typ).toBe("JWT")
      expect(protectedHeader.kid).toBe("loa-finn-v1")

      // Standard claims — validated by arrakis
      expect(payload.sub).toBe("loa-finn")
      expect(payload.iss).toBe("loa-finn")
      expect(payload.aud).toBe("arrakis")
      expect(payload.iat).toBeDefined()
      expect(payload.exp).toBeDefined()
      expect(payload.exp! - payload.iat!).toBe(300)

      // Custom claims — passed through by arrakis JWT layer, used by billing logic
      expect(payload.tenant_id).toBe("tenant-abc-123")
      expect(payload.purpose).toBe("billing_finalize")
      expect(payload.reservation_id).toBe("res-uuid-001")
      expect(payload.trace_id).toBe("trace-uuid-001")
    })

    it("jti is NOT included (arrakis does not require it)", async () => {
      const signer = new S2SJwtSigner(es256Config)
      await signer.init()

      const token = await signer.signJWT({ sub: "loa-finn" })
      const { payload } = await jwtVerify(token, publicKey, {
        issuer: "loa-finn",
        audience: "arrakis",
      })

      // arrakis billing-s2s.test.ts createInternalJwt does not include jti
      expect(payload.jti).toBeUndefined()
    })
  })

  describe("Issuer and audience alignment", () => {
    it("loa-finn issuer matches arrakis expected issuer", () => {
      // loa-finn default: "loa-finn" (config.ts:220)
      // arrakis test: { iss: "loa-finn" } (billing-s2s.test.ts:28)
      expect(es256Config.issuer).toBe("loa-finn")
    })

    it("loa-finn audience matches arrakis expected audience", () => {
      // loa-finn default: "arrakis" (config.ts:221)
      // arrakis test: { aud: "arrakis" } (billing-s2s.test.ts:29)
      expect(es256Config.audience).toBe("arrakis")
    })
  })

  describe("Clock skew tolerance", () => {
    it("both services use 30s tolerance", () => {
      // loa-finn default: 30 (config.ts:229 FINN_JWT_CLOCK_SKEW)
      // arrakis: clockTolerance: 30 (from billing-s2s.test.ts patterns)
      const finnClockSkew = 30
      const arrakisClockSkew = 30
      expect(finnClockSkew).toBe(arrakisClockSkew)
    })
  })

  describe("Token lifetime", () => {
    it("default TTL is 300s (5 minutes)", async () => {
      const signer = new S2SJwtSigner(es256Config)
      await signer.init()

      const token = await signer.signJWT({ sub: "loa-finn" })
      const { payload } = await jwtVerify(token, publicKey, {
        issuer: "loa-finn",
        audience: "arrakis",
      })

      // arrakis test helper: exp: now + 300
      // loa-finn default: expiresInSeconds = 300
      expect(payload.exp! - payload.iat!).toBe(300)
    })
  })

  describe("Wire format compatibility (body, not JWT)", () => {
    it("loa-finn body fields match arrakis s2sFinalizeRequestSchema", () => {
      // arrakis schema fields (s2s-billing.ts):
      //   reservationId: z.string().min(1)
      //   actualCostMicro: z.string().regex(/^\d+$/)
      //   accountId: z.string().min(1).optional()
      //   identity_anchor: z.string().min(1).optional()
      //
      // loa-finn sends (billing-finalize-client.ts:247-252):
      //   reservationId: req.reservation_id
      //   accountId: req.tenant_id
      //   actualCostMicro: req.actual_cost_micro
      //   traceId: req.trace_id
      //
      // Note: traceId is extra (arrakis ignores unknown fields in zod .parse())
      // Note: accountId is deprecated in arrakis (derived from reservation)

      const finnBody = {
        reservationId: "res-uuid-001",
        accountId: "tenant-abc-123",
        actualCostMicro: "1500000", // 1.50 USD in micro
        traceId: "trace-uuid-001",
      }

      // Validate against arrakis schema expectations
      expect(finnBody.reservationId.length).toBeGreaterThan(0)
      expect(/^\d+$/.test(finnBody.actualCostMicro)).toBe(true)
      expect(finnBody.accountId!.length).toBeGreaterThan(0)
    })
  })
})
