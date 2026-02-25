// tests/e2e/budget-conservation.test.ts — Budget Conservation E2E Test
//
// Validates that a tenant whose budget is exhausted receives HTTP 429
// with an evaluation_gap error body.
//
// Requires:
//   CHEVAL_MODE=mock  (deterministic inference)
//   Redis on port 6380
//   Finn on http://localhost:3001
//   ioredis installed (npm i -D ioredis)

import { describe, it, expect, beforeAll } from "vitest"
import { importPKCS8, SignJWT } from "jose"
import { randomUUID, createHash } from "node:crypto"
import { loadPrivateKeyPem } from "./helpers.js"
import Redis from "ioredis"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FINN_URL = process.env.FINN_URL ?? "http://localhost:3001"
const REDIS_PORT = Number(process.env.E2E_REDIS_PORT ?? 6380)
const TENANT_ID = `e2e-budget-${randomUUID()}`

// ---------------------------------------------------------------------------
// Key Material — reads the SAME key finn uses (from .env.e2e)
// ---------------------------------------------------------------------------

let privateKey: Awaited<ReturnType<typeof importPKCS8>>

beforeAll(async () => {
  const pem = loadPrivateKeyPem()
  privateKey = await importPKCS8(pem, "ES256")
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex digest of a request body, formatted as `sha256:<hex>`. */
function reqHash(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`
}

/** Mint a signed ES256 JWT with the standard E2E claims. */
async function mintJWT(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const jti = randomUUID()

  const claims: Record<string, unknown> = {
    iss: "e2e-harness",
    aud: "loa-finn",
    tenant_id: TENANT_ID,
    tier: "pro",
    req_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    jti,
    exp: now + 60,
    ...overrides,
  }

  return new SignJWT(claims as Record<string, unknown>)
    .setProtectedHeader({ alg: "ES256", kid: "e2e-v1" })
    .sign(privateKey)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Budget Conservation — Exhausted Budget Returns 429", () => {
  it("budget exhaustion returns 429", async () => {
    // -----------------------------------------------------------------------
    // 1. Set a very low budget for the tenant via Redis
    // -----------------------------------------------------------------------
    const redis = new Redis({ port: REDIS_PORT, lazyConnect: true })

    try {
      await redis.connect()

      // Set budget to a tiny value (1 unit) so the next request exhausts it
      await redis.set(`budget:${TENANT_ID}`, "1")

      // Verify the budget was written
      const budget = await redis.get(`budget:${TENANT_ID}`)
      expect(budget).toBe("1")
    } finally {
      await redis.quit()
    }

    // -----------------------------------------------------------------------
    // 2. Mint JWT and attempt to create a session / send a request
    // -----------------------------------------------------------------------
    const body = JSON.stringify({ tenant_id: TENANT_ID })
    const token = await mintJWT({ req_hash: reqHash(body) })

    const response = await fetch(`${FINN_URL}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body,
    })

    // -----------------------------------------------------------------------
    // 3. Assert HTTP 429 — budget exhausted
    // -----------------------------------------------------------------------
    expect(response.status).toBe(429)

    // -----------------------------------------------------------------------
    // 4. Assert response body mentions evaluation_gap
    // -----------------------------------------------------------------------
    const responseBody = await response.text()
    expect(responseBody.toLowerCase()).toContain("evaluation_gap")
  }, 30_000)
})
