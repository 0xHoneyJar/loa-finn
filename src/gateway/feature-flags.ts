// src/gateway/feature-flags.ts — Feature Flag Middleware (Sprint 6 Task 6.2)
//
// Redis-backed feature flags for staged rollout.
// Default flags: billing, credits, nft, onboarding, x402.
// Admin API for toggle with WAL audit.

import { Hono } from "hono"
import type { RedisCommandClient } from "../hounfour/redis/client.js"
import { AllowlistService, normalizeAddress } from "./allowlist.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLAG_PREFIX = "feature:"
const FLAG_SUFFIX = ":enabled"
const DEFAULT_FLAGS = ["billing", "credits", "nft", "onboarding", "x402"] as const

export type FeatureFlag = (typeof DEFAULT_FLAGS)[number] | string

// ---------------------------------------------------------------------------
// Feature Flag Service
// ---------------------------------------------------------------------------

export interface FeatureFlagDeps {
  redis: RedisCommandClient
  walAppend?: (namespace: string, operation: string, key: string, payload: unknown) => string
}

export class FeatureFlagService {
  private readonly redis: RedisCommandClient
  private readonly walAppend: FeatureFlagDeps["walAppend"]

  constructor(deps: FeatureFlagDeps) {
    this.redis = deps.redis
    this.walAppend = deps.walAppend
  }

  /**
   * Check if a feature flag is enabled.
   */
  async isEnabled(flag: string): Promise<boolean> {
    const key = `${FLAG_PREFIX}${flag}${FLAG_SUFFIX}`
    const value = await this.redis.get(key)
    return value === "1" || value === "true"
  }

  /**
   * Set a feature flag.
   */
  async setFlag(flag: string, enabled: boolean): Promise<void> {
    const key = `${FLAG_PREFIX}${flag}${FLAG_SUFFIX}`
    await this.redis.set(key, enabled ? "1" : "0")
    this.writeAudit("feature_flag_toggle", { flag, enabled })
  }

  /**
   * Get all known flag states.
   */
  async getAllFlags(): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {}
    for (const flag of DEFAULT_FLAGS) {
      result[flag] = await this.isEnabled(flag)
    }
    return result
  }

  private writeAudit(operation: string, payload: Record<string, unknown>): void {
    if (!this.walAppend) return
    try {
      this.walAppend("feature_flags", operation, "feature_flags", {
        ...payload,
        timestamp: Date.now(),
      })
    } catch {
      // Best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Admin Routes (Task 6.2)
// ---------------------------------------------------------------------------

export interface AdminRouteDeps {
  allowlistService: AllowlistService
  featureFlagService: FeatureFlagService
  /** Validate admin JWT — returns true if token has role: "admin" */
  validateAdminToken: (token: string) => Promise<boolean>
}

export function adminRoutes(deps: AdminRouteDeps): Hono {
  const app = new Hono()

  // Admin auth middleware
  app.use("*", async (c, next) => {
    const auth = c.req.header("Authorization")
    if (!auth?.startsWith("Bearer ")) {
      return c.json({ error: "Admin authentication required", code: "ADMIN_AUTH_REQUIRED" }, 401)
    }
    const token = auth.slice(7)
    try {
      const isAdmin = await deps.validateAdminToken(token)
      if (!isAdmin) {
        return c.json({ error: "Admin role required", code: "ADMIN_ROLE_REQUIRED" }, 403)
      }
    } catch {
      return c.json({ error: "Invalid admin token", code: "ADMIN_AUTH_INVALID" }, 401)
    }
    return next()
  })

  // POST /api/v1/admin/allowlist
  app.post("/allowlist", async (c) => {
    const body = await c.req.json<{ action: "add" | "remove"; addresses: string[] }>()

    if (!body.action || !Array.isArray(body.addresses)) {
      return c.json({ error: "Invalid request: need action and addresses", code: "INVALID_REQUEST" }, 400)
    }

    if (body.action === "add") {
      const result = await deps.allowlistService.addAddresses(body.addresses)
      return c.json(result)
    } else if (body.action === "remove") {
      const result = await deps.allowlistService.removeAddresses(body.addresses)
      return c.json(result)
    }

    return c.json({ error: "action must be 'add' or 'remove'", code: "INVALID_REQUEST" }, 400)
  })

  // POST /api/v1/admin/feature-flags
  app.post("/feature-flags", async (c) => {
    const body = await c.req.json<{ flag: string; enabled: boolean }>()
    if (!body.flag || typeof body.enabled !== "boolean") {
      return c.json({ error: "Invalid request: need flag and enabled", code: "INVALID_REQUEST" }, 400)
    }

    await deps.featureFlagService.setFlag(body.flag, body.enabled)
    return c.json({ flag: body.flag, enabled: body.enabled })
  })

  // GET /api/v1/admin/feature-flags
  app.get("/feature-flags", async (c) => {
    const flags = await deps.featureFlagService.getAllFlags()
    return c.json({ flags })
  })

  return app
}
