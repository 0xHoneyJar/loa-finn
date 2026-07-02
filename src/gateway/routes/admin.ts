// src/gateway/routes/admin.ts — Admin API (SDD §8.1, cycle-035 T-2.1)
//
// Two auth tiers:
//   1. JWKS JWT (ES256, kid selection) — routing mode changes (operator-facing)
//   2. Injected admin token (FINN_AUTH_TOKEN via deps) — seed-credits (CI/CD test support, Sprint 3)
//
// Routing mode change: audit-first semantics (write audit intent BEFORE Redis set).
// If Redis fails after audit intent → 503 (detectable state, operator retries).
//
// Hardening (#199, #200, #201, #204, #223, #225):
// - Rate limiting is injectable: Redis-backed store shares state across replicas
//   in production; the in-memory default is per-process (dev/single-instance only).
// - seed-credits validates wallet format (EVM 0x-address) BEFORE normalization,
//   bounds credits to a documented safe cap, and writes an audit record per
//   mutation (audit-first, fail-closed).
// - The admin token arrives via typed deps, not a process.env read in the handler.

import { Hono } from "hono"
import { timingSafeEqual } from "node:crypto"
import { jwtVerify, type JWTVerifyResult } from "jose"
import type { RuntimeConfig, RoutingMode } from "../../hounfour/runtime-config.js"
import type { RedisCommandClient } from "../../hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** jose v6 key material (KeyLike was removed in jose ≥6.2). */
export type AdminJwksKey = CryptoKey | Uint8Array

export interface AdminRouteDeps {
  /** Idempotent credit setter — overwrites balance (does not increment). */
  setCreditBalance: (wallet: string, credits: number) => Promise<void>
  /** Bearer token protecting seed-credits (from config, NOT read from env here). */
  authToken?: string
  /** Runtime config for routing mode changes. */
  runtimeConfig?: RuntimeConfig
  /** Audit logger for mode change intents and credit mutations. */
  auditAppend?: (action: string, payload: Record<string, unknown>) => Promise<string | null>
  /** JWKS key resolver (from jose createLocalJWKSet). */
  jwksKeyResolver?: (protectedHeader: { kid?: string; alg?: string }, token: { payload: unknown }) => Promise<AdminJwksKey>
  /**
   * Rate limiter for mode changes. Inject a RedisAdminRateLimiter in
   * production so the limit is shared across replicas (#199, #223).
   * Defaults to an in-memory per-process limiter (dev/single-instance only).
   */
  rateLimiter?: AdminRateLimiter
  /** Maximum credits accepted by seed-credits (default: MAX_SEED_CREDITS). */
  maxSeedCredits?: number
}

interface ModeChangeRequest {
  mode?: string
}

interface SeedCreditsRequest {
  wallet_address?: string
  credits?: number
}

const VALID_MODES = new Set<string>(["enabled", "disabled", "shadow"])

/** EVM address: 0x + 40 hex chars. Validated BEFORE lowercasing (#201). */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Default seed-credits cap (#200). seed-credits is a test/CI support endpoint;
 * 1,000,000 whole credits is far above any legitimate test fixture while
 * keeping a fat-fingered or malicious value from minting unbounded balance.
 * Override via AdminRouteDeps.maxSeedCredits.
 * Policy doc: docs/gateway-admin-seed-credits-policy.md
 */
export const MAX_SEED_CREDITS = 1_000_000

// ---------------------------------------------------------------------------
// Rate limiting (#199, #214, #223)
// ---------------------------------------------------------------------------

export const RATE_LIMIT_MAX = 5
export const RATE_LIMIT_WINDOW_MS = 3_600_000 // 1 hour

export interface AdminRateLimiter {
  /** Returns true when the subject is allowed to perform another mode change. */
  check(subject: string): Promise<boolean>
}

/**
 * Per-process in-memory limiter. NOT shared across replicas — suitable for
 * dev/single-instance deployments only. Production must inject
 * RedisAdminRateLimiter (see createApp wiring in server.ts).
 */
export class InMemoryAdminRateLimiter implements AdminRateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly max: number = RATE_LIMIT_MAX,
    private readonly windowMs: number = RATE_LIMIT_WINDOW_MS,
  ) {}

  async check(subject: string): Promise<boolean> {
    const now = Date.now()
    const entry = this.entries.get(subject)
    if (!entry || now > entry.resetAt) {
      this.entries.set(subject, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (entry.count >= this.max) return false
    entry.count++
    return true
  }
}

/**
 * Redis-backed fixed-window limiter — shared across all replicas.
 * Fixed window (INCR + EXPIRE) is sufficient for a 5/hour operator action.
 * Fails CLOSED on Redis errors: a mode change is a privileged, low-frequency
 * operation; denying it during a Redis outage is safer than unbounded changes.
 */
export class RedisAdminRateLimiter implements AdminRateLimiter {
  constructor(
    private readonly redis: RedisCommandClient,
    private readonly max: number = RATE_LIMIT_MAX,
    private readonly windowMs: number = RATE_LIMIT_WINDOW_MS,
  ) {}

  async check(subject: string): Promise<boolean> {
    const key = `finn:admin:mode-rl:${subject}`
    try {
      const count = await this.redis.incr(key)
      if (count === 1) {
        await this.redis.expire(key, Math.ceil(this.windowMs / 1000))
      }
      return count <= this.max
    } catch (err) {
      console.error(JSON.stringify({
        metric: "admin.rate_limit_redis_error",
        error: (err as Error).message,
        subject,
        timestamp: Date.now(),
      }))
      return false // fail-closed
    }
  }
}

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

export function createAdminRoutes(deps: AdminRouteDeps): Hono {
  const app = new Hono()
  const rateLimiter = deps.rateLimiter ?? new InMemoryAdminRateLimiter()
  const maxSeedCredits = deps.maxSeedCredits ?? MAX_SEED_CREDITS

  if (!deps.rateLimiter) {
    console.warn(
      "[admin] using in-memory mode-change rate limiter — per-process only; " +
      "inject a Redis-backed limiter for multi-replica deployments (#199)",
    )
  }

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

    // Rate limit: 5 mode changes per subject per hour (shared store in prod)
    if (!(await rateLimiter.check(subject))) {
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
  // Injected admin token middleware for seed-credits (#204)
  // -------------------------------------------------------------------------

  const tokenAuth = async (c: Parameters<Parameters<typeof app.use>[1]>[0], next: () => Promise<void>) => {
    const expectedToken = deps.authToken
    if (!expectedToken) {
      return c.json(
        { error: "Admin endpoints disabled — admin auth token not configured", code: "ADMIN_DISABLED" },
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
  //
  // Input policy (#200, #201, #225 — docs/gateway-admin-seed-credits-policy.md):
  // - wallet_address: EVM 0x-address, format-validated BEFORE lowercasing
  // - credits: whole non-negative safe integer, capped at maxSeedCredits
  // - every accepted mutation writes an audit record first (fail-closed)
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

    // Format validation BEFORE normalization (#201): lowercasing an arbitrary
    // string is not a validity check — reject anything that is not an EVM address.
    if (!EVM_ADDRESS_RE.test(body.wallet_address)) {
      return c.json(
        { error: "wallet_address must be an EVM address (0x + 40 hex chars)", code: "INVALID_REQUEST" },
        400,
      )
    }

    // Bounds (#200): whole non-negative integer, capped. Rejects fractional,
    // negative, non-finite (NaN/Infinity), unsafe-integer, and huge values.
    if (
      body.credits == null ||
      typeof body.credits !== "number" ||
      !Number.isSafeInteger(body.credits) ||
      body.credits < 0
    ) {
      return c.json(
        { error: "credits is required and must be a non-negative whole number", code: "INVALID_REQUEST" },
        400,
      )
    }
    if (body.credits > maxSeedCredits) {
      return c.json(
        { error: `credits exceeds maximum (${maxSeedCredits})`, code: "CREDITS_OUT_OF_BOUNDS" },
        400,
      )
    }

    // Normalization policy: EVM addresses are case-insensitive; balances are
    // keyed by the lowercased form.
    const wallet = body.wallet_address.toLowerCase()

    // Audit-first (#225, #234): record the mutation intent before applying it.
    if (deps.auditAppend) {
      try {
        await deps.auditAppend("seed_credits", {
          intent: "seed_credits",
          wallet_address: wallet,
          credits: body.credits,
          timestamp: new Date().toISOString(),
        })
      } catch (err) {
        console.error(JSON.stringify({
          metric: "admin.seed_credits_audit_failed",
          error: (err as Error).message,
          timestamp: Date.now(),
        }))
        return c.json(
          { error: "Audit system unavailable — credit seeding blocked (fail-closed)", code: "AUDIT_FAILED" },
          503,
        )
      }
    }

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
