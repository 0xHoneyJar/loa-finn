// tests/e2e/flag-promotion.test.ts — Feature Flag Promotion E2E Tests
//
// Validates each flag individually and collectively via admin API.
// Covers toggle, readback, x402 behavioral verification, all-on, and rollback.
//
// Requires:
//   Finn on http://localhost:3001
//   .env.e2e with FINN_S2S_PRIVATE_KEY (base64-encoded PEM)

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { importPKCS8, SignJWT } from "jose"
import { randomUUID } from "node:crypto"
import { readFileSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FINN_URL = process.env.FINN_URL ?? "http://localhost:3001"
const TENANT_ID = `e2e-flags-${randomUUID()}`

/**
 * The 5 known flags in DEFAULT_FLAGS order (feature-flags.ts).
 * Promotion order: billing -> credits -> nft -> onboarding -> x402
 */
const ALL_FLAGS = ["billing", "credits", "nft", "onboarding", "x402"] as const
type FlagName = (typeof ALL_FLAGS)[number]

// ---------------------------------------------------------------------------
// Key Material — reads the SAME key finn uses (from .env.e2e)
// ---------------------------------------------------------------------------

let privateKey: Awaited<ReturnType<typeof importPKCS8>>

function loadPrivateKeyPem(): string {
  const fromEnv = process.env.E2E_ES256_PRIVATE_KEY
  if (fromEnv) return Buffer.from(fromEnv, "base64").toString("utf-8")

  const __filename = fileURLToPath(import.meta.url)
  const __dir = dirname(__filename)
  const candidates = [
    resolve(__dir, ".env.e2e"),
    resolve(process.cwd(), "tests/e2e/.env.e2e"),
    resolve(process.cwd(), ".env.e2e"),
  ]
  const envPath = candidates.find((p) => existsSync(p))
  if (!envPath) throw new Error("Unable to locate .env.e2e for FINN_S2S_PRIVATE_KEY")

  const content = readFileSync(envPath, "utf-8")
  const match = content.match(/^FINN_S2S_PRIVATE_KEY=(.+)$/m)
  if (!match) throw new Error("FINN_S2S_PRIVATE_KEY not found in .env.e2e")
  return Buffer.from(match[1].trim(), "base64").toString("utf-8")
}

beforeAll(async () => {
  const pem = loadPrivateKeyPem()
  privateKey = await importPKCS8(pem, "ES256")
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mint an admin JWT with { aud: "loa-finn-admin", role: "admin" }.
 * Uses the same ES256 key and kid: "e2e-v1" header as other E2E tests.
 */
async function mintAdminJWT(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const jti = randomUUID()

  const claims: Record<string, unknown> = {
    iss: "e2e-harness",
    aud: "loa-finn-admin",
    role: "admin",
    tenant_id: TENANT_ID,
    jti,
    exp: now + 120,
    ...overrides,
  }

  return new SignJWT(claims as Record<string, unknown>)
    .setProtectedHeader({ alg: "ES256", kid: "e2e-v1" })
    .sign(privateKey)
}

/**
 * Toggle a single feature flag via POST /api/v1/admin/feature-flags.
 */
async function toggleFlag(
  flag: string,
  enabled: boolean,
  token: string,
): Promise<Response> {
  return fetch(`${FINN_URL}/api/v1/admin/feature-flags`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ flag, enabled }),
  })
}

/**
 * Get all feature flag states via GET /api/v1/admin/feature-flags.
 */
async function getAllFlags(token: string): Promise<Response> {
  return fetch(`${FINN_URL}/api/v1/admin/feature-flags`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
}

/**
 * Hit x402/invoke without payment to test behavioral response.
 * x402 ON  -> 402 (Payment Required)
 * x402 OFF -> 503 (Feature Disabled)
 */
async function probeX402(): Promise<Response> {
  return fetch(`${FINN_URL}/api/v1/x402/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      prompt: "e2e flag promotion probe",
    }),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Feature Flag Promotion — Admin API", () => {
  let adminToken: string

  beforeAll(async () => {
    adminToken = await mintAdminJWT()
  })

  // -------------------------------------------------------------------------
  // 1. Admin JWT minting
  // -------------------------------------------------------------------------

  it("mints admin JWT with { aud: 'loa-finn-admin', role: 'admin' }", async () => {
    // Verify the token is accepted by GET /api/v1/admin/feature-flags
    const res = await getAllFlags(adminToken)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { flags: Record<string, boolean> }
    expect(body).toHaveProperty("flags")
    expect(typeof body.flags).toBe("object")
  })

  // -------------------------------------------------------------------------
  // 2. Toggle each flag individually
  // -------------------------------------------------------------------------

  describe("individual flag toggles", () => {
    for (const flag of ALL_FLAGS) {
      it(`toggles '${flag}' ON via POST, verifies via GET`, async () => {
        // Enable the flag
        const postRes = await toggleFlag(flag, true, adminToken)
        expect(postRes.status).toBe(200)

        const postBody = (await postRes.json()) as { flag: string; enabled: boolean }
        expect(postBody.flag).toBe(flag)
        expect(postBody.enabled).toBe(true)

        // Verify via GET
        const getRes = await getAllFlags(adminToken)
        expect(getRes.status).toBe(200)

        const getBody = (await getRes.json()) as { flags: Record<string, boolean> }
        expect(getBody.flags[flag]).toBe(true)
      })

      it(`toggles '${flag}' OFF via POST, verifies via GET`, async () => {
        // Disable the flag
        const postRes = await toggleFlag(flag, false, adminToken)
        expect(postRes.status).toBe(200)

        const postBody = (await postRes.json()) as { flag: string; enabled: boolean }
        expect(postBody.flag).toBe(flag)
        expect(postBody.enabled).toBe(false)

        // Verify via GET
        const getRes = await getAllFlags(adminToken)
        expect(getRes.status).toBe(200)

        const getBody = (await getRes.json()) as { flags: Record<string, boolean> }
        expect(getBody.flags[flag]).toBe(false)
      })
    }
  })

  // -------------------------------------------------------------------------
  // 3. x402 behavioral verification — flag ON produces 402, flag OFF produces 503
  // -------------------------------------------------------------------------

  describe("x402 flag behavioral verification", () => {
    it("x402 flag ON: /api/v1/x402/invoke returns 402 (Payment Required)", async () => {
      // Enable x402
      const toggleRes = await toggleFlag("x402", true, adminToken)
      expect(toggleRes.status).toBe(200)

      // Probe — no payment header, so server should return 402
      const probeRes = await probeX402()
      expect(probeRes.status).toBe(402)

      const body = (await probeRes.json()) as { code: string; quote?: unknown }
      expect(body.code).toBe("PAYMENT_REQUIRED")
      expect(body).toHaveProperty("quote")
    })

    it("x402 flag OFF: /api/v1/x402/invoke returns 503 (Feature Disabled)", async () => {
      // Disable x402
      const toggleRes = await toggleFlag("x402", false, adminToken)
      expect(toggleRes.status).toBe(200)

      // Probe — flag is off, so server should return 503
      const probeRes = await probeX402()
      expect(probeRes.status).toBe(503)

      const body = (await probeRes.json()) as { code: string }
      expect(body.code).toBe("FEATURE_DISABLED")
    })
  })

  // -------------------------------------------------------------------------
  // 4. All-on test: enable all flags simultaneously, verify all enabled
  // -------------------------------------------------------------------------

  it("all-on: enables all flags, verifies all enabled", async () => {
    // Enable all flags
    for (const flag of ALL_FLAGS) {
      const res = await toggleFlag(flag, true, adminToken)
      expect(res.status).toBe(200)
    }

    // Verify all flags are ON
    const getRes = await getAllFlags(adminToken)
    expect(getRes.status).toBe(200)

    const body = (await getRes.json()) as { flags: Record<string, boolean> }
    for (const flag of ALL_FLAGS) {
      expect(body.flags[flag]).toBe(true)
    }

    // All 5 flags should be present
    const flagKeys = Object.keys(body.flags)
    expect(flagKeys.length).toBeGreaterThanOrEqual(ALL_FLAGS.length)
    for (const flag of ALL_FLAGS) {
      expect(flagKeys).toContain(flag)
    }
  })

  // -------------------------------------------------------------------------
  // 5. Rollback test: disable all flags, verify all disabled
  // -------------------------------------------------------------------------

  it("rollback: disables all flags, verifies all disabled", async () => {
    // First ensure all are ON (idempotent setup)
    for (const flag of ALL_FLAGS) {
      await toggleFlag(flag, true, adminToken)
    }

    // Now disable all flags
    for (const flag of ALL_FLAGS) {
      const res = await toggleFlag(flag, false, adminToken)
      expect(res.status).toBe(200)
    }

    // Verify all flags are OFF
    const getRes = await getAllFlags(adminToken)
    expect(getRes.status).toBe(200)

    const body = (await getRes.json()) as { flags: Record<string, boolean> }
    for (const flag of ALL_FLAGS) {
      expect(body.flags[flag]).toBe(false)
    }
  })

  // -------------------------------------------------------------------------
  // 6. Flag promotion order documentation
  // -------------------------------------------------------------------------

  describe("flag promotion order", () => {
    /**
     * Documents the expected promotion order per the PRD gate model:
     *
     *   Gate 0 (Smoke):    billing
     *   Gate 1 (Ignition): billing, credits
     *   Gate 2 (Warmup):   billing, credits, nft, onboarding
     *   Gate 3 (Idle):     billing, credits, nft, onboarding  (+ BYOK)
     *   Gate 4 (Launch):   billing, credits, nft, onboarding, x402
     */
    const PROMOTION_ORDER: readonly FlagName[][] = [
      ["billing"],                                          // Gate 0
      ["billing", "credits"],                               // Gate 1
      ["billing", "credits", "nft", "onboarding"],          // Gate 2
      ["billing", "credits", "nft", "onboarding"],          // Gate 3
      ["billing", "credits", "nft", "onboarding", "x402"],  // Gate 4
    ] as const

    it("progressive promotion: each gate is a superset of the previous", async () => {
      // Reset all flags to OFF
      for (const flag of ALL_FLAGS) {
        await toggleFlag(flag, false, adminToken)
      }

      for (let gate = 0; gate < PROMOTION_ORDER.length; gate++) {
        const gateFlags = PROMOTION_ORDER[gate]

        // Enable flags for this gate
        for (const flag of gateFlags) {
          await toggleFlag(flag, true, adminToken)
        }

        // Verify expected state
        const getRes = await getAllFlags(adminToken)
        expect(getRes.status).toBe(200)

        const body = (await getRes.json()) as { flags: Record<string, boolean> }

        for (const flag of ALL_FLAGS) {
          const expected = gateFlags.includes(flag)
          expect(
            body.flags[flag],
            `Gate ${gate}: flag '${flag}' expected ${expected}`,
          ).toBe(expected)
        }

        // Reset non-gate flags to OFF before next gate (clean slate per gate)
        for (const flag of ALL_FLAGS) {
          if (!gateFlags.includes(flag)) {
            await toggleFlag(flag, false, adminToken)
          }
        }
      }
    })

    it("rollback from Gate 4 to Gate 2: disable x402 only", async () => {
      // Set Gate 4 (all on)
      for (const flag of ALL_FLAGS) {
        await toggleFlag(flag, true, adminToken)
      }

      // Rollback to Gate 2: disable x402
      const res = await toggleFlag("x402", false, adminToken)
      expect(res.status).toBe(200)

      // Verify: everything on except x402
      const getRes = await getAllFlags(adminToken)
      expect(getRes.status).toBe(200)

      const body = (await getRes.json()) as { flags: Record<string, boolean> }
      expect(body.flags.billing).toBe(true)
      expect(body.flags.credits).toBe(true)
      expect(body.flags.nft).toBe(true)
      expect(body.flags.onboarding).toBe(true)
      expect(body.flags.x402).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Cleanup — disable all flags after test suite
  // -------------------------------------------------------------------------

  afterAll(async () => {
    try {
      const token = await mintAdminJWT()
      for (const flag of ALL_FLAGS) {
        await toggleFlag(flag, false, token)
      }
    } catch {
      // Best-effort cleanup
    }
  })
})
