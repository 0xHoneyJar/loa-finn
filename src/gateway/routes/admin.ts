// src/gateway/routes/admin.ts — Admin API (SDD §8.1, cycle-035 T-2.1)
//
// Two auth tiers:
//   1. JWKS JWT (ES256, kid selection) — routing mode changes (operator-facing)
//   2. FINN_AUTH_TOKEN header — seed-credits (CI/CD test support, Sprint 3)
//
// Routing mode change: audit-first semantics (write audit intent BEFORE Redis set).
// If Redis fails after audit intent → 503 (detectable state, operator retries).

import { Hono } from "hono"
import { timingSafeEqual } from "node:crypto"
import { jwtVerify, type KeyLike, type JWTVerifyResult } from "jose"
import type { RuntimeConfig, RoutingMode } from "../../hounfour/runtime-config.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdminRouteDeps {
  /** Idempotent credit setter — overwrites balance (does not increment). */
  setCreditBalance: (wallet: string, credits: number) => Promise<void>
  /** Runtime config for routing mode changes. */
  runtimeConfig?: RuntimeConfig
  /** Audit logger for mode change intents. */
  auditAppend?: (action: string, payload: Record<string, unknown>) => Promise<string | null>
  /** JWKS key resolver (from jose createLocalJWKSet). */
  jwksKeyResolver?: (protectedHeader: { kid?: string; alg?: string }, token: { payload: unknown }) => Promise<KeyLike | Uint8Array>
}

interface ModeChangeRequest {
  mode?: string
}

interface SeedCreditsRequest {
  wallet_address?: string
  credits?: number
}

const VALID_MODES = new Set<string>(["enabled", "disabled", "shadow"])

// Per-subject rate limit: track mode changes per subject per hour
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 3_600_000 // 1 hour

function checkRateLimit(subject: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(subject)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(subject, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  if (entry.count >= RATE_LIMIT_MAX) return false
  entry.count++
  return true
}

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

export function createAdminRoutes(deps: AdminRouteDeps): Hono {
  const app = new Hono()

  // -------------------------------------------------------------------------
  // JWKS JWT auth middleware for /mode endpoints
  // -------------------------------------------------------------------------

  const jwtAuth = async (c: Parameters<Parameters<typeof app.use>[1]>[0], next: () => Promise<void>) => {
    if (!deps.jwksKeyResolver) {
      return c.json({ error: "Admin JWKS not configured", code: "ADMIN_DISABLED" }, 503)
    }

    const authHeader = c.req.header("Authorization")
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null
    if (!token) {
      return c.json({ error: "Missing authorization token", code: "AUTH_MISSING" }, 401)
    }

    let result: JWTVerifyResult
    try {
      result = await jwtVerify(token, deps.jwksKeyResolver, {
        algorithms: ["ES256"],
      })
    } catch (err) {
      const message = (err as Error).message
      if (message.includes("expired")) {
        return c.json({ error: "Token expired", code: "TOKEN_EXPIRED" }, 401)
      }
      return c.json({ error: "Invalid token", code: "AUTH_FAILED" }, 401)
    }

    // Check role claim
    const payload = result.payload as Record<string, unknown>
    if (payload.role !== "operator" && payload.role !== "admin") {
      return c.json({ error: "Insufficient role", code: "ROLE_DENIED" }, 403)
    }

    // Store subject for rate limiting and audit
    c.set("adminSubject" as never, (payload.sub ?? "unknown") as never)
    return next()
  }

  // -------------------------------------------------------------------------
  // GET /mode — Current routing mode
  // -------------------------------------------------------------------------

  app.get("/mode", jwtAuth, async (c) => {
    if (!deps.runtimeConfig) {
      return c.json({ error: "RuntimeConfig not available" }, 503)
    }

    const mode = await deps.runtimeConfig.getMode()
    return c.json({ mode, timestamp: new Date().toISOString() })
  })

  // -------------------------------------------------------------------------
  // POST /mode — Change routing mode (audit-first)
  // -------------------------------------------------------------------------

  app.post("/mode", jwtAuth, async (c) => {
    if (!deps.runtimeConfig) {
      return c.json({ error: "RuntimeConfig not available" }, 503)
    }

    const subject = c.get("adminSubject" as never) as string ?? "unknown"

    // Rate limit: 5 mode changes per subject per hour
    if (!checkRateLimit(subject)) {
      return c.json(
        { error: "Rate limit exceeded (5 mode changes per hour)", code: "RATE_LIMITED" },
        429,
      )
    }

    let body: ModeChangeRequest
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid request body" }, 400)
    }

    if (!body.mode || !VALID_MODES.has(body.mode)) {
      return c.json(
        { error: `Invalid mode. Must be one of: ${[...VALID_MODES].join(", ")}`, code: "INVALID_MODE" },
        400,
      )
    }

    const previousMode = await deps.runtimeConfig.getMode()
    const newMode = body.mode as RoutingMode

    // Step 1: Write audit intent BEFORE Redis set (audit-first semantics)
    if (deps.auditAppend) {
      try {
        await deps.auditAppend("routing_mode_change", {
          intent: "mode_change",
          from: previousMode,
          to: newMode,
          subject,
          timestamp: new Date().toISOString(),
        })
      } catch (err) {
        // Audit failure → 503 (fail-closed)
        console.error(JSON.stringify({
          metric: "admin.audit_intent_failed",
          error: (err as Error).message,
          subject,
          timestamp: Date.now(),
        }))
        return c.json(
          { error: "Audit system unavailable — mode change blocked (fail-closed)", code: "AUDIT_FAILED" },
          503,
        )
      }
    }

    // Step 2: Apply mode change to Redis
    try {
      await deps.runtimeConfig.setMode(newMode)
    } catch (err) {
      // Redis write failed after audit intent — detectable state
      // Log best-effort failure audit
      if (deps.auditAppend) {
        deps.auditAppend("routing_mode_change_failed", {
          from: previousMode,
          to: newMode,
          subject,
          error: (err as Error).message,
          timestamp: new Date().toISOString(),
        }).catch(() => {}) // Best-effort
      }

      console.error(JSON.stringify({
        metric: "admin.mode_change_failed",
        error: (err as Error).message,
        subject,
        timestamp: Date.now(),
      }))

      return c.json(
        { error: "Mode change failed — audit intent exists, Redis write failed", code: "MODE_CHANGE_FAILED" },
        503,
      )
    }

    console.log(JSON.stringify({
      metric: "admin.mode_changed",
      from: previousMode,
      to: newMode,
      subject,
      timestamp: Date.now(),
    }))

    return c.json({
      mode: newMode,
      previousMode,
      subject,
      timestamp: new Date().toISOString(),
    })
  })

  // -------------------------------------------------------------------------
  // FINN_AUTH_TOKEN middleware for seed-credits
  // -------------------------------------------------------------------------

  const tokenAuth = async (c: Parameters<Parameters<typeof app.use>[1]>[0], next: () => Promise<void>) => {
    const expectedToken = process.env.FINN_AUTH_TOKEN
    if (!expectedToken) {
      return c.json(
        { error: "Admin endpoints disabled — FINN_AUTH_TOKEN not configured", code: "ADMIN_DISABLED" },
        503,
      )
    }

    const authHeader = c.req.header("Authorization")
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null
    if (!token) {
      return c.json({ error: "Invalid or missing authorization token", code: "AUTH_FAILED" }, 401)
    }

    const expected = Buffer.from(expectedToken)
    const provided = Buffer.from(token)
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return c.json({ error: "Invalid or missing authorization token", code: "AUTH_FAILED" }, 401)
    }

    return next()
  }

  // -------------------------------------------------------------------------
  // POST /seed-credits — Idempotent credit seeding (Sprint 3 E2E)
  // -------------------------------------------------------------------------

  app.post("/seed-credits", tokenAuth, async (c) => {
    let body: SeedCreditsRequest
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid request body" }, 400)
    }

    if (!body.wallet_address || typeof body.wallet_address !== "string") {
      return c.json(
        { error: "wallet_address is required and must be a string", code: "INVALID_REQUEST" },
        400,
      )
    }

    if (body.credits == null || typeof body.credits !== "number" || !Number.isFinite(body.credits) || body.credits < 0) {
      return c.json(
        { error: "credits is required and must be a non-negative number", code: "INVALID_REQUEST" },
        400,
      )
    }

    const wallet = body.wallet_address.toLowerCase()

    try {
      await deps.setCreditBalance(wallet, body.credits)
      return c.json({ wallet_address: wallet, credits: body.credits, seeded: true }, 200)
    } catch (err) {
      console.error("[admin] seed-credits error:", err)
      return c.json({ error: "Failed to seed credits" }, 500)
    }
  })

  return app
}
