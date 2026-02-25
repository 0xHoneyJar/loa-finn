// src/gateway/routes/admin.ts — Admin Seed Endpoint (Sprint 3)
//
// POST /api/v1/admin/seed-credits — Seeds credits for a test wallet.
// Protected by FINN_AUTH_TOKEN header auth (not browser-accessible).
// Idempotent: sets credit balance, does not add to existing.

import { Hono } from "hono"
import { timingSafeEqual } from "node:crypto"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdminRouteDeps {
  /** Idempotent credit setter — overwrites balance (does not increment). */
  setCreditBalance: (wallet: string, credits: number) => Promise<void>
}

interface SeedCreditsRequest {
  wallet_address?: string
  credits?: number
}

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

/**
 * Create admin routes for E2E test support.
 *
 * Auth: Requires `FINN_AUTH_TOKEN` header. Not gated by SIWE or JWT —
 * this is a server-to-server endpoint for CI/CD seed scripts.
 */
export function createAdminRoutes(deps: AdminRouteDeps): Hono {
  const app = new Hono()

  // -------------------------------------------------------------------------
  // Auth middleware — FINN_AUTH_TOKEN header validation
  // -------------------------------------------------------------------------

  app.use("*", async (c, next) => {
    const expectedToken = process.env.FINN_AUTH_TOKEN
    if (!expectedToken) {
      return c.json(
        { error: "Admin endpoints disabled — FINN_AUTH_TOKEN not configured", code: "ADMIN_DISABLED" },
        503,
      )
    }

    const authHeader = c.req.header("Authorization")
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null

    if (!token) {
      return c.json(
        { error: "Invalid or missing authorization token", code: "AUTH_FAILED" },
        401,
      )
    }

    // Timing-safe comparison to prevent side-channel attacks
    const expected = Buffer.from(expectedToken)
    const provided = Buffer.from(token)
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return c.json(
        { error: "Invalid or missing authorization token", code: "AUTH_FAILED" },
        401,
      )
    }

    return next()
  })

  // -------------------------------------------------------------------------
  // POST /seed-credits — Idempotent credit seeding
  // -------------------------------------------------------------------------

  app.post("/seed-credits", async (c) => {
    let body: SeedCreditsRequest
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid request body" }, 400)
    }

    // Validate wallet_address
    if (!body.wallet_address || typeof body.wallet_address !== "string") {
      return c.json(
        { error: "wallet_address is required and must be a string", code: "INVALID_REQUEST" },
        400,
      )
    }

    // Validate credits
    if (body.credits == null || typeof body.credits !== "number" || !Number.isFinite(body.credits) || body.credits < 0) {
      return c.json(
        { error: "credits is required and must be a non-negative number", code: "INVALID_REQUEST" },
        400,
      )
    }

    const wallet = body.wallet_address.toLowerCase()

    try {
      await deps.setCreditBalance(wallet, body.credits)

      return c.json({
        wallet_address: wallet,
        credits: body.credits,
        seeded: true,
      }, 200)
    } catch (err) {
      console.error("[admin] seed-credits error:", err)
      return c.json({ error: "Failed to seed credits" }, 500)
    }
  })

  return app
}
