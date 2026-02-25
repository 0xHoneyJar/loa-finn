// src/gateway/csp.ts — Content Security Policy Middleware (T2.14)
//
// Hono middleware that sets CSP headers on HTML responses.
// Skipped for API JSON responses to avoid unnecessary header overhead.

import type { MiddlewareHandler } from "hono"

// ---------------------------------------------------------------------------
// CSP Directives
// ---------------------------------------------------------------------------

const CSP_DIRECTIVES: Record<string, string> = {
  "default-src": "'self'",
  "script-src": "'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "style-src": "'self' 'unsafe-inline'",
  "connect-src": "'self' wss: https://base-mainnet.g.alchemy.com https://mainnet.base.org",
  "img-src": "'self' data: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "frame-src": "'none'",
  "frame-ancestors": "'none'",
  "object-src": "'none'",
  "base-uri": "'self'",
  "form-action": "'self'",
}

/** Pre-built CSP header value (immutable at runtime) */
const CSP_HEADER_VALUE = Object.entries(CSP_DIRECTIVES)
  .map(([directive, value]) => `${directive} ${value}`)
  .join("; ")

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Content Security Policy middleware for Hono.
 *
 * Only applies CSP headers to HTML responses. JSON API responses are skipped
 * to avoid unnecessary header overhead. Detection uses both the request Accept
 * header and the response Content-Type header.
 */
export function cspMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await next()

    // Only apply CSP to HTML responses
    if (!isHtmlResponse(c.req.header("accept"), c.res.headers.get("content-type"))) {
      return
    }

    c.res.headers.set("Content-Security-Policy", CSP_HEADER_VALUE)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine if the response is HTML by checking:
 * 1. The response Content-Type header (authoritative if present)
 * 2. The request Accept header (fallback signal)
 *
 * Returns false for JSON, plain text, and other non-HTML content types.
 */
function isHtmlResponse(
  acceptHeader: string | undefined,
  contentType: string | null,
): boolean {
  // Response Content-Type is authoritative when present
  if (contentType) {
    return contentType.includes("text/html")
  }

  // Fall back to Accept header if no Content-Type yet
  if (acceptHeader) {
    return acceptHeader.includes("text/html")
  }

  return false
}
