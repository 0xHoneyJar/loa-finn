// src/gateway/auth.ts — Authentication middleware (SDD §3.2.4, T-2.7)

import { createHash, timingSafeEqual } from "node:crypto"
import type { Context, Next } from "hono"
import type { FinnConfig } from "../config.js"

/** Timing-safe string comparison (constant-time even for different lengths) */
function safeCompare(a: string, b: string): boolean {
  const bufA = createHash("sha256").update(a).digest()
  const bufB = createHash("sha256").update(b).digest()
  return timingSafeEqual(bufA, bufB)
}

/** Bearer token auth middleware for REST API routes */
export function authMiddleware(config: FinnConfig) {
  return async (c: Context, next: Next) => {
    // Skip auth if no token configured (dev mode)
    if (!config.auth.bearerToken) {
      return next()
    }

    const authHeader = c.req.header("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, 401)
    }

    const token = authHeader.slice(7)
    if (!safeCompare(token, config.auth.bearerToken)) {
      return c.json({ error: "Unauthorized", code: "AUTH_INVALID" }, 401)
    }

    return next()
  }
}

/** Validate WS auth token from query string */
export function validateWsToken(token: string | undefined, config: FinnConfig): boolean {
  if (!config.auth.bearerToken) return true // No auth in dev mode
  if (!token) return false
  return safeCompare(token, config.auth.bearerToken)
}

/** CORS middleware */
export function corsMiddleware(config: FinnConfig) {
  return async (c: Context, next: Next) => {
    const origin = c.req.header("Origin")

    if (origin && isOriginAllowed(origin, config.auth.corsOrigins)) {
      c.header("Access-Control-Allow-Origin", origin)
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization")
      c.header("Access-Control-Allow-Credentials", "true")
    }

    if (c.req.method === "OPTIONS") {
      return new Response(null, { status: 204 })
    }

    return next()
  }
}

function isOriginAllowed(origin: string, patterns: string[]): boolean {
  let parsedOrigin: URL
  try {
    parsedOrigin = new URL(origin)
  } catch {
    return false // Reject malformed origins
  }

  for (const pattern of patterns) {
    if (pattern === "*") return true
    if (pattern.includes("*")) {
      // Escape regex special chars except *, then replace * with [a-zA-Z0-9.-]*
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-zA-Z0-9.:-]*")
      const regex = new RegExp("^" + escaped + "$")
      if (regex.test(origin)) return true
    } else {
      // Exact match only — no suffix matching (prevents evil.com matching example.com)
      if (origin === pattern) return true
    }
  }
  return false
}
