// tests/fixtures/mock-arrakis-server.ts — Mock arrakis server (T-A.10)
// Lightweight Hono app implementing JWKS, usage-reports, and budget endpoints
// per PRD §6.1-6.4 for integration tests.

import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT } from "jose"

// --- Types ---

export interface MockArrakisState {
  /** Received usage reports (keyed by report_id) */
  usageReports: Map<string, unknown>
  /** Number of usage report failures injected */
  usageFailsRemaining: number
  /** Budget state per tenant (micro-USD) */
  budgets: Map<string, { spent_micro: number; limit_micro: number }>
}

export interface MockArrakisServer {
  /** HTTP port */
  port: number
  /** JWKS URL for JWT validation */
  jwksUrl: string
  /** Sign a JWT with the mock keypair */
  signJWT(claims: Record<string, unknown>): Promise<string>
  /** Export private key PEM (for S2S signer tests) */
  privateKeyPem: string
  /** Mutable state for assertions */
  state: MockArrakisState
  /** Stop the server */
  close(): void
}

/**
 * Start a mock arrakis server on a random port.
 * Returns the server handle with signing utilities and mutable state.
 */
export async function startMockArrakis(): Promise<MockArrakisServer> {
  const keyPair = await generateKeyPair("ES256", { extractable: true })
  const privateKeyPem = await exportPKCS8(keyPair.privateKey)
  const publicJWK = await exportJWK(keyPair.publicKey)
  publicJWK.kid = "arrakis-key-1"
  publicJWK.alg = "ES256"
  publicJWK.use = "sig"

  const state: MockArrakisState = {
    usageReports: new Map(),
    usageFailsRemaining: 0,
    budgets: new Map(),
  }

  const app = new Hono()

  // JWKS endpoint (§6.1)
  app.get("/.well-known/jwks.json", (c) => {
    return c.json({ keys: [publicJWK] })
  })

  // Usage reports endpoint (§6.3)
  app.post("/internal/usage-reports", async (c) => {
    const auth = c.req.header("Authorization")
    if (!auth?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    if (state.usageFailsRemaining > 0) {
      state.usageFailsRemaining--
      return c.json({ error: "Service unavailable" }, 503)
    }

    const body = await c.req.json<{ report_id: string; jws_payload: string }>()

    // Idempotency
    if (state.usageReports.has(body.report_id)) {
      return c.json({ status: "duplicate", report_id: body.report_id })
    }

    state.usageReports.set(body.report_id, body)
    return c.json({ status: "accepted", report_id: body.report_id }, 201)
  })

  // Budget query endpoint (§6.2)
  app.get("/internal/budget/:tenant_id", (c) => {
    const auth = c.req.header("Authorization")
    if (!auth?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    const tenantId = c.req.param("tenant_id")
    const budget = state.budgets.get(tenantId) ?? { spent_micro: 0, limit_micro: 10_000_000 }

    return c.json({
      tenant_id: tenantId,
      spent_micro: budget.spent_micro,
      limit_micro: budget.limit_micro,
      remaining_micro: budget.limit_micro - budget.spent_micro,
    })
  })

  const signJWT = async (claims: Record<string, unknown>): Promise<string> => {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "arrakis-key-1" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(keyPair.privateKey)
  }

  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve({
        port: info.port,
        jwksUrl: `http://localhost:${info.port}/.well-known/jwks.json`,
        signJWT,
        privateKeyPem,
        state,
        close: () => server.close(),
      })
    })
  })
}
