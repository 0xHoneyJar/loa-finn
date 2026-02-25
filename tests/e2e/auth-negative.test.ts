// tests/e2e/auth-negative.test.ts — Auth Negative E2E Tests
//
// Validates that the auth layer correctly rejects malformed, expired,
// replayed, and unauthorized tokens.
//
// Requires:
//   Finn on http://localhost:3001

import { describe, it, expect, beforeAll } from "vitest"
import { generateKeyPair, exportPKCS8, importPKCS8, SignJWT } from "jose"
import { randomUUID } from "node:crypto"
import { loadPrivateKeyPem } from "./helpers.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FINN_URL = process.env.FINN_URL ?? "http://localhost:3001"
const TENANT_ID = `e2e-auth-neg-${randomUUID()}`

// ---------------------------------------------------------------------------
// Key Material — primary key from .env.e2e (same as finn), alternate is fresh
// ---------------------------------------------------------------------------

let primaryPrivateKey: Awaited<ReturnType<typeof importPKCS8>>
let alternatePrivateKey: Awaited<ReturnType<typeof importPKCS8>>

beforeAll(async () => {
  // Primary keypair — same key finn uses for JWKS
  const pem = loadPrivateKeyPem()
  primaryPrivateKey = await importPKCS8(pem, "ES256")

  // Alternate keypair — used for "unknown kid" test (finn won't recognize it)
  const altKp = await generateKeyPair("ES256")
  const altPkcs8 = await exportPKCS8(altKp.privateKey)
  alternatePrivateKey = await importPKCS8(altPkcs8, "ES256")
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MintOptions {
  /** Override or omit specific claims. Use `undefined` to omit a claim. */
  claims?: Record<string, unknown>
  /** Override protected header fields. */
  header?: Record<string, unknown>
  /** Use an alternate signing key. */
  signingKey?: Awaited<ReturnType<typeof importPKCS8>>
}

/**
 * Mint a signed ES256 JWT with customizable claims and header.
 * Claims set to `undefined` are removed from the payload.
 */
async function mintToken(opts: MintOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const jti = randomUUID()

  const baseClaims: Record<string, unknown> = {
    iss: "e2e-harness",
    aud: "loa-finn",
    tenant_id: TENANT_ID,
    tier: "pro",
    req_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    jti,
    exp: now + 60,
  }

  // Merge overrides
  const merged = { ...baseClaims, ...opts.claims }

  // Remove any claims explicitly set to undefined
  for (const [key, val] of Object.entries(merged)) {
    if (val === undefined) {
      delete merged[key]
    }
  }

  const header: Record<string, unknown> = {
    alg: "ES256",
    kid: "e2e-v1",
    ...opts.header,
  }

  const key = opts.signingKey ?? primaryPrivateKey

  return new SignJWT(merged as Record<string, unknown>)
    .setProtectedHeader(header as { alg: string })
    .sign(key)
}

/** POST /api/sessions with the given bearer token. */
async function postSession(token: string): Promise<Response> {
  return fetch(`${FINN_URL}/api/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ tenant_id: TENANT_ID }),
  })
}

/** POST /api/v1/admin/feature-flags with the given bearer token. */
async function postAdminFlags(token: string): Promise<Response> {
  return fetch(`${FINN_URL}/api/v1/admin/feature-flags`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ flag: "test", enabled: true }),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Auth Negative — Token Rejection Cases", () => {
  // -------------------------------------------------------------------------
  // 1. Wrong audience
  // -------------------------------------------------------------------------
  it("wrong aud -> 403", async () => {
    const token = await mintToken({
      claims: { aud: "wrong-audience" },
    })

    const res = await postSession(token)
    expect(res.status).toBe(403)
  })

  // -------------------------------------------------------------------------
  // 2. Missing exp
  // -------------------------------------------------------------------------
  it("missing exp -> 401", async () => {
    const token = await mintToken({
      claims: { exp: undefined },
    })

    const res = await postSession(token)
    expect(res.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // 3. Expired token
  // -------------------------------------------------------------------------
  it("expired token -> 401", async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await mintToken({
      claims: { exp: now - 60 },
    })

    const res = await postSession(token)
    expect(res.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // 4. Future nbf (not-before)
  // -------------------------------------------------------------------------
  it("future nbf -> 401", async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await mintToken({
      claims: { nbf: now + 3600 },
    })

    const res = await postSession(token)
    expect(res.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // 5. Missing role on admin endpoint
  // -------------------------------------------------------------------------
  it("missing role on admin -> 403", async () => {
    // Standard user token (no role claim) hitting admin endpoint
    const token = await mintToken({
      claims: { aud: "loa-finn-admin", tenant_id: "e2e-admin" },
    })

    const res = await postAdminFlags(token)
    expect(res.status).toBe(403)
  })

  // -------------------------------------------------------------------------
  // 6. role=user on admin endpoint
  // -------------------------------------------------------------------------
  it("role=user on admin -> 403", async () => {
    const token = await mintToken({
      claims: {
        aud: "loa-finn-admin",
        tenant_id: "e2e-admin",
        role: "user",
      },
    })

    const res = await postAdminFlags(token)
    expect(res.status).toBe(403)
  })

  // -------------------------------------------------------------------------
  // 7. Unknown kid
  // -------------------------------------------------------------------------
  it("unknown kid -> 401", async () => {
    const token = await mintToken({
      header: { kid: "unknown-kid" },
      signingKey: alternatePrivateKey,
    })

    const res = await postSession(token)
    expect(res.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // 8. Replayed jti
  // -------------------------------------------------------------------------
  it("replayed jti -> 401", async () => {
    const fixedJti = randomUUID()

    // First request — should succeed (or at least not 401 for jti replay).
    // We only need the first to register the jti in the replay cache.
    const token1 = await mintToken({
      claims: { jti: fixedJti },
    })
    const res1 = await postSession(token1)

    // The first request may return various status codes depending on other
    // auth/budget state, but the important assertion is on the second request.
    expect(res1.status).toBeDefined()

    // Second request with the same jti — should be rejected as replay
    const token2 = await mintToken({
      claims: { jti: fixedJti },
    })
    const res2 = await postSession(token2)
    expect(res2.status).toBe(401)
  })
})
