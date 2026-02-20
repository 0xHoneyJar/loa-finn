// src/gateway/routes/keys.ts — API Key Lifecycle Endpoints (Sprint 4 T4.6)
//
// SIWE-authenticated endpoints for API key management:
// - POST   /api/v1/keys              → create key (returns plaintext once)
// - DELETE /api/v1/keys/:key_id      → revoke key (must own it)
// - GET    /api/v1/keys/:key_id/balance → check credit balance

import { Hono } from "hono"
import type { ApiKeyManager } from "../api-keys.js"
import { requireSiweSession } from "../siwe-auth.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeyRouteDeps {
  apiKeyManager: ApiKeyManager
  jwtSecret: string
}

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

/**
 * Create API key lifecycle routes.
 * All routes require a valid SIWE session JWT.
 */
export function createKeyRoutes(deps: KeyRouteDeps): Hono {
  const app = new Hono()

  // All key management endpoints require SIWE session
  app.use("/*", requireSiweSession(deps.jwtSecret))

  // POST / — Create a new API key
  app.post("/", async (c) => {
    const walletAddress = c.get("siwe_wallet") as string

    let label = ""
    try {
      const body = await c.req.json()
      if (typeof body.label === "string") {
        label = body.label.slice(0, 128) // Cap label length
      }
    } catch {
      // Empty body is fine — label is optional
    }

    const result = await deps.apiKeyManager.create(walletAddress, label)

    return c.json({
      key_id: result.keyId,
      plaintext_key: result.plaintextKey,
      message: "Store this key securely. It will not be shown again.",
    }, 201)
  })

  // DELETE /:key_id — Revoke an API key (must own it)
  app.delete("/:key_id", async (c) => {
    const walletAddress = c.get("siwe_wallet") as string
    const keyId = c.req.param("key_id")

    const revoked = await deps.apiKeyManager.revoke(keyId, walletAddress)

    if (!revoked) {
      return c.json({ error: "Key not found or not owned by this wallet" }, 404)
    }

    return c.json({ key_id: keyId, revoked: true })
  })

  // GET /:key_id/balance — Check credit balance
  app.get("/:key_id/balance", async (c) => {
    const keyId = c.req.param("key_id")

    const balance = await deps.apiKeyManager.getBalance(keyId)

    if (balance === null) {
      return c.json({ error: "Key not found" }, 404)
    }

    return c.json({ key_id: keyId, balance_micro: balance })
  })

  return app
}
