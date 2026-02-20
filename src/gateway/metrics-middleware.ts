// src/gateway/metrics-middleware.ts — Request Metrics Middleware (Sprint 6 T6.3, T6.4)
//
// Hono middleware that records per-request metrics:
// - finn_http_requests_total counter
// - finn_request_duration_seconds histogram
// - finn_http_errors_total counter (for 4xx/5xx)
//
// Label cardinality enforced: no user-controlled values in labels.
// Route is normalized (e.g., /api/v1/agent/chat, not /api/v1/agent/chat?q=foo).

import type { MiddlewareHandler } from "hono"
import { metrics } from "./metrics-endpoint.js"

// ---------------------------------------------------------------------------
// Route normalization (prevents high-cardinality labels)
// ---------------------------------------------------------------------------

/** Normalize route to prevent high-cardinality label explosion. */
function normalizeRoute(path: string): string {
  // Strip query string
  const base = path.split("?")[0]

  // Normalize known parameterized routes
  return base
    .replace(/\/api\/v1\/keys\/[^/]+\/balance$/, "/api/v1/keys/:key_id/balance")
    .replace(/\/api\/v1\/keys\/[^/]+$/, "/api/v1/keys/:key_id")
    .replace(/\/api\/v1\/agent\/[^/]+$/, "/api/v1/agent/:tokenId")
    .replace(/\/api\/sessions\/[^/]+\/message$/, "/api/sessions/:id/message")
    .replace(/\/api\/sessions\/[^/]+$/, "/api/sessions/:id")
    .replace(/\/agent\/[^/]+$/, "/agent/:tokenId")
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Records HTTP request metrics (counter + histogram).
 * Must be registered early in the middleware chain to capture full request duration.
 */
export function metricsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now()

    await next()

    const durationSeconds = (performance.now() - start) / 1000
    const route = normalizeRoute(c.req.path)
    const method = c.req.method
    const status = String(c.res.status)

    // Request counter
    metrics.incrementCounter("finn_http_requests_total", { route, method, status })

    // Latency histogram
    metrics.observeHistogram("finn_request_duration_seconds", { route, method }, durationSeconds)

    // Error counter for 4xx/5xx
    if (c.res.status >= 400) {
      metrics.incrementCounter("finn_http_errors_total", { route, method, status })
    }
  }
}
