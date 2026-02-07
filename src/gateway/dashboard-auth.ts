// src/gateway/dashboard-auth.ts — Dashboard auth with Bearer + RBAC (SDD §6.4, TASK-6.4)

import { createHash, timingSafeEqual } from "node:crypto"

// ── Types ────────────────────────────────────────────────────

export interface DashboardAuthConfig {
  adminToken: string   // The admin token (from env or generated)
  bindAddress: string  // "127.0.0.1" or "0.0.0.0"
}

export type Role = "viewer" | "operator"

export interface AuthRequest {
  headers: Record<string, string>
  remoteAddr: string  // Client IP
}

export interface AuthResult {
  status: number
  body: { error: string; code: string }
}

// ── Localhost detection ──────────────────────────────────────

const LOCALHOST_ADDRS = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
])

function isLocalhostAddr(addr: string): boolean {
  return LOCALHOST_ADDRS.has(addr)
}

// ── Timing-safe comparison ───────────────────────────────────

/** Timing-safe string comparison via SHA-256 digest (constant-time even for different lengths). */
function safeCompare(a: string, b: string): boolean {
  const bufA = createHash("sha256").update(a).digest()
  const bufB = createHash("sha256").update(b).digest()
  return timingSafeEqual(bufA, bufB)
}

// ── DashboardAuth ────────────────────────────────────────────

/**
 * Framework-agnostic dashboard auth with RBAC.
 *
 * Role model:
 * - `viewer`   — read-only; localhost pass-through when bound to 127.0.0.1
 * - `operator` — mutating; always requires valid Bearer token
 *
 * Any valid Bearer token grants operator-level access.
 * Localhost without token grants viewer-level access (when bound to loopback).
 */
/** Minimum token length to prevent brute-force (256 bits = 32 bytes = 64 hex chars, but 32 chars is the floor). */
const MIN_TOKEN_LENGTH = 32

export class DashboardAuth {
  private readonly config: DashboardAuthConfig

  constructor(config: DashboardAuthConfig) {
    if (typeof config.adminToken !== "string" || config.adminToken.length === 0) {
      throw new Error(
        `Admin token is required. ` +
        `Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      )
    }
    if (config.adminToken.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `Admin token too short (${config.adminToken.length} chars, need >= ${MIN_TOKEN_LENGTH}). ` +
        `Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      )
    }
    this.config = config
  }

  /**
   * Check access for a request against a required role.
   * Returns `null` if access is granted, or an `AuthResult` error to send back.
   */
  checkAccess(req: AuthRequest, requiredRole: Role): AuthResult | null {
    const isLoopbackBind = this.config.bindAddress === "127.0.0.1"
    const isLocalClient = isLocalhostAddr(req.remoteAddr)

    // Localhost viewer pass-through: skip token ONLY for viewer role
    // when bound to loopback and client is local. Operator role always requires token.
    if (isLoopbackBind && isLocalClient && requiredRole === "viewer") {
      return null
    }

    // All other cases require a valid Bearer token.
    return this.checkToken(req)
  }

  // ── Private helpers ──────────────────────────────────────

  /** Validate Bearer token from Authorization header. */
  private checkToken(req: AuthRequest): AuthResult | null {
    const authHeader = req.headers["authorization"] ?? req.headers["Authorization"]
    if (!authHeader?.startsWith("Bearer ")) {
      return { status: 401, body: { error: "Unauthorized", code: "AUTH_REQUIRED" } }
    }

    const token = authHeader.slice(7)
    if (!safeCompare(token, this.config.adminToken)) {
      return { status: 401, body: { error: "Unauthorized", code: "AUTH_INVALID" } }
    }

    return null
  }
}
