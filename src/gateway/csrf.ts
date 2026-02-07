// src/gateway/csrf.ts — Double-submit cookie CSRF protection (SDD §6.6, TASK-6.6)

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

// ── Types ────────────────────────────────────────────────────

export interface CsrfConfig {
  tokenLength?: number     // bytes of randomness; default: 32 (→ 64 hex chars)
  cookieName?: string      // default: "_csrf"
  headerName?: string      // default: "x-csrf-token"
  formFieldName?: string   // default: "_csrf"
}

export interface CsrfRequest {
  method: string
  headers: Record<string, string>
  cookies?: Record<string, string>
  body?: Record<string, unknown>
}

export interface CsrfResult {
  valid: boolean
  error?: string
  token?: string          // The generated token to embed in forms/cookies
  cookieHeader?: string   // Set-Cookie header value to send
}

// ── Safe methods that skip CSRF validation ───────────────────

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

// ── CsrfProtection ──────────────────────────────────────────

/**
 * Framework-agnostic double-submit cookie CSRF protection.
 *
 * Flow:
 * 1. Server generates a token via `generateToken()`, sets it as an HttpOnly
 *    cookie and embeds the same value in a hidden form field.
 * 2. On mutating requests the class checks that the cookie token matches
 *    the token submitted in the form body or the `x-csrf-token` header.
 * 3. Bearer-authenticated API requests bypass CSRF entirely.
 */
/** Timing-safe string comparison via SHA-256 digest. */
function safeCompare(a: string, b: string): boolean {
  const bufA = createHash("sha256").update(a).digest()
  const bufB = createHash("sha256").update(b).digest()
  return timingSafeEqual(bufA, bufB)
}

export class CsrfProtection {
  private readonly tokenLength: number
  private readonly cookieName: string
  private readonly headerName: string
  private readonly formFieldName: string

  constructor(config?: CsrfConfig) {
    this.tokenLength = config?.tokenLength ?? 32
    this.cookieName = config?.cookieName ?? "_csrf"
    this.headerName = config?.headerName ?? "x-csrf-token"
    this.formFieldName = config?.formFieldName ?? "_csrf"
  }

  /** Generate a new CSRF token with its Set-Cookie header. */
  generateToken(): { token: string; cookieHeader: string } {
    const token = randomBytes(this.tokenLength).toString("hex")
    const cookieHeader = `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`
    return { token, cookieHeader }
  }

  /** Validate a request. Returns valid:true for safe/bypassed requests, or valid:false with error. */
  validate(req: CsrfRequest): CsrfResult {
    // Safe methods never need CSRF validation
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      return { valid: true }
    }

    // Bearer token requests bypass CSRF (API clients, not browser forms)
    const authHeader = req.headers["authorization"] ?? req.headers["Authorization"]
    if (authHeader?.startsWith("Bearer ")) {
      return { valid: true }
    }

    // Mutating request from a browser — double-submit check
    const cookieToken = req.cookies?.[this.cookieName]
    if (!cookieToken) {
      return { valid: false, error: "CSRF cookie missing" }
    }

    const submittedToken =
      (req.body?.[this.formFieldName] as string | undefined) ??
      req.headers[this.headerName] ??
      req.headers[this.headerName.toLowerCase()]

    if (!submittedToken) {
      return { valid: false, error: "CSRF token missing from request" }
    }

    if (!safeCompare(cookieToken, submittedToken)) {
      return { valid: false, error: "CSRF token mismatch" }
    }

    return { valid: true }
  }
}
