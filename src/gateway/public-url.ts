// src/gateway/public-url.ts — Trusted public URL construction (#198, #224, #230, #236)
//
// Public-facing URLs (e.g. the session WebSocket URL returned by
// POST /api/sessions) MUST come from trusted configuration, never from the
// untrusted Host request header. A forged Host header would otherwise let an
// attacker redirect WebSocket clients to a host they control.
//
// Policy:
// - When PUBLIC_BASE_URL is configured, it is the single source of truth.
//   https:// → wss://, http:// → ws://.
// - When not configured (dev/local only), the Host header is used as a
//   fallback ONLY when it is syntactically valid AND names a loopback/local
//   host (localhost, *.localhost, 127.0.0.0/8, 0.0.0.0). A syntactically
//   valid but non-local Host header is NEVER echoed back — that would
//   preserve the Host-header URL-forgery class in a misconfigured
//   production deployment. Anything else falls back to localhost:<port>.

/** RFC-952/1123-ish hostname (or IPv4) with optional :port. No underscores, schemes, paths, or whitespace. */
const HOST_HEADER_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,253}[a-zA-Z0-9])?(:\d{1,5})?$/

/** Loopback/local hostnames eligible for the dev Host-header fallback. */
function isLoopbackHost(host: string): boolean {
  const hostname = host.replace(/:\d{1,5}$/, "").toLowerCase()
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true
  if (hostname === "0.0.0.0") return true
  return /^127(\.\d{1,3}){3}$/.test(hostname)
}

/**
 * Validate a configured public base URL. Returns the normalized origin
 * (scheme://host[:port], no trailing slash, no path).
 * Throws on anything that is not an absolute http(s) URL.
 */
export function validatePublicBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`PUBLIC_BASE_URL must be an absolute URL (got "${raw}")`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`PUBLIC_BASE_URL must use http:// or https:// (got "${url.protocol}//")`)
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`PUBLIC_BASE_URL must not contain a path, query, or fragment (got "${raw}")`)
  }
  return url.origin
}

/**
 * Validate an untrusted Host header value for the DEV fallback. Returns the
 * host only when it is syntactically safe AND loopback/local — a forged but
 * well-formed public hostname must never become the advertised WS origin.
 */
export function sanitizeHostHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  if (hostHeader.length > 260) return null
  if (!HOST_HEADER_RE.test(hostHeader)) return null
  if (!isLoopbackHost(hostHeader)) return null
  return hostHeader
}

export interface SessionWsUrlOptions {
  /** Normalized public base URL from config (empty string when unset). */
  publicBaseUrl: string
  /** Raw Host header from the request (untrusted). */
  hostHeader: string | undefined
  /** Server listen port — used for the localhost fallback. */
  port: number
  sessionId: string
}

/**
 * Build the WebSocket URL returned to session-creating clients.
 *
 * Precedence: configured PUBLIC_BASE_URL > validated Host header (dev
 * fallback, always ws://) > localhost:<port>.
 */
export function buildSessionWsUrl(opts: SessionWsUrlOptions): string {
  if (opts.publicBaseUrl) {
    const url = new URL(opts.publicBaseUrl)
    const wsScheme = url.protocol === "https:" ? "wss" : "ws"
    return `${wsScheme}://${url.host}/ws/${opts.sessionId}`
  }

  const safeHost = sanitizeHostHeader(opts.hostHeader) ?? `localhost:${opts.port}`
  return `ws://${safeHost}/ws/${opts.sessionId}`
}
