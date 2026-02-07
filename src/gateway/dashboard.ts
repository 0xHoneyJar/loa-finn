// src/gateway/dashboard.ts — Server-rendered dashboard UI (SDD §6.5, TASK-6.5)

import { createHash, timingSafeEqual } from "node:crypto"

// ── Request / Response types (shared with other gateway modules) ──

export interface ApiRequest {
  method: string
  path: string
  headers: Record<string, string>
  body?: unknown
  params?: Record<string, string>
  query?: Record<string, string>
}

export interface ApiResponse {
  status: number
  body: unknown
}

// ── Dependency interfaces ────────────────────────────────────────

export interface DashboardUIConfig {
  wsEndpoint?: string // WebSocket URL for live updates, default "/ws"
}

export interface DashboardUIDeps {
  overviewApi: { handle(req: ApiRequest): Promise<ApiResponse> }
  authToken: string
}

// ── DashboardOverview shape (mirrors dashboard-routes.ts) ────────

interface DashboardOverview {
  status: "healthy" | "degraded" | "stopped"
  killSwitch: boolean
  jobs: { total: number; enabled: number; running: number; circuitOpen: number }
  last24h: {
    runsTotal: number
    runsSucceeded: number
    runsFailed: number
    githubHttpRequests: number
    githubMutations: number
    itemsProcessed: number
  }
  rateLimits: { githubRemaining: number; githubResetAt: string }
  auditIntegrity: { lastVerified: string; chainValid: boolean; totalRecords: number }
  circuitBreakers: Array<{
    jobId: string
    state: string
    failures: number
    lastFailureAt: string | null
  }>
}

// ── Dashboard class ──────────────────────────────────────────────

/**
 * Framework-agnostic server-rendered HTML dashboard.
 * Generates HTML strings — no SPA framework required.
 */
export class Dashboard {
  private readonly deps: DashboardUIDeps
  private readonly wsEndpoint: string

  constructor(deps: DashboardUIDeps, config?: DashboardUIConfig) {
    this.deps = deps
    this.wsEndpoint = config?.wsEndpoint ?? "/ws"
  }

  /** Dispatch a request through routing. */
  async handle(req: ApiRequest): Promise<ApiResponse> {
    const method = req.method.toUpperCase()
    const path = req.path

    if (method === "GET" && path === "/dashboard") {
      return this.renderDashboardPage(req)
    }

    if (method === "POST" && path === "/dashboard/kill-switch") {
      return this.handleKillSwitch(req)
    }

    return { status: 404, body: { error: "Not found", code: "ROUTE_NOT_FOUND" } }
  }

  // ── GET /dashboard ──────────────────────────────────────────

  private async renderDashboardPage(req: ApiRequest): Promise<ApiResponse> {
    // Fetch overview data via the API (pass through auth headers)
    const apiReq: ApiRequest = {
      method: "GET",
      path: "/api/dashboard/overview",
      headers: req.headers,
    }
    const apiRes = await this.deps.overviewApi.handle(apiReq)

    if (apiRes.status !== 200) {
      return apiRes // propagate auth errors etc.
    }

    const overview = apiRes.body as DashboardOverview
    const html = renderDashboard(overview, this.wsEndpoint)

    return {
      status: 200,
      body: html,
    }
  }

  // ── POST /dashboard/kill-switch ─────────────────────────────

  private handleKillSwitch(req: ApiRequest): Promise<ApiResponse> {
    // Auth check — operator-level always requires token
    const authErr = this.checkAuth(req)
    if (authErr) return Promise.resolve(authErr)

    // Redirect back to dashboard (PRG pattern)
    return Promise.resolve({
      status: 303,
      body: { redirect: "/dashboard" },
    })
  }

  // ── Auth ────────────────────────────────────────────────────

  private checkAuth(req: ApiRequest): ApiResponse | null {
    const authHeader = req.headers["authorization"] ?? req.headers["Authorization"]
    if (!authHeader?.startsWith("Bearer ")) {
      return { status: 401, body: { error: "Unauthorized", code: "AUTH_REQUIRED" } }
    }

    const token = authHeader.slice(7)
    if (!safeCompare(token, this.deps.authToken)) {
      return { status: 401, body: { error: "Unauthorized", code: "AUTH_INVALID" } }
    }

    return null
  }
}

// ── HTML Rendering ───────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function renderDashboard(overview: DashboardOverview, wsEndpoint: string): string {
  const statusClass = `status-${overview.status}`

  // Build circuit breaker rows
  const cbRows = overview.circuitBreakers.length > 0
    ? overview.circuitBreakers.map((cb) => `
            <tr>
              <td>${escapeHtml(cb.jobId)}</td>
              <td><span class="status-badge status-cb-${escapeHtml(cb.state)}">${escapeHtml(cb.state)}</span></td>
              <td>${cb.failures}</td>
              <td>${cb.lastFailureAt ? escapeHtml(cb.lastFailureAt) : "—"}</td>
            </tr>`).join("")
    : `<tr><td colspan="4">No circuit breakers configured</td></tr>`

  // Rate limit gauge (percentage of 5000 default GitHub limit)
  const ratePct = overview.rateLimits.githubRemaining >= 0
    ? Math.min(100, Math.round((overview.rateLimits.githubRemaining / 5000) * 100))
    : 0
  const gaugeColor = ratePct > 50 ? "#28a745" : ratePct > 20 ? "#ffc107" : "#dc3545"

  // Audit integrity indicator
  const auditIcon = overview.auditIntegrity.chainValid ? "&#10003;" : "&#10007;"
  const auditClass = overview.auditIntegrity.chainValid ? "audit-valid" : "audit-broken"

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Finn Agent Jobs Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; }
    .card { background: white; border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .status-badge { display: inline-block; padding: 4px 12px; border-radius: 12px; font-weight: bold; }
    .status-healthy { background: #d4edda; color: #155724; }
    .status-degraded { background: #fff3cd; color: #856404; }
    .status-stopped { background: #f8d7da; color: #721c24; }
    .status-cb-open { background: #f8d7da; color: #721c24; }
    .status-cb-closed { background: #d4edda; color: #155724; }
    .status-cb-half-open { background: #fff3cd; color: #856404; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #dee2e6; }
    th { background: #f8f9fa; }
    .gauge { height: 20px; background: #e9ecef; border-radius: 10px; overflow: hidden; }
    .gauge-fill { height: 100%; transition: width 0.3s; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .stat-item { text-align: center; }
    .stat-value { font-size: 2em; font-weight: bold; }
    .stat-label { color: #6c757d; font-size: 0.9em; }
    .audit-valid { color: #155724; }
    .audit-broken { color: #721c24; }
    button { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
    .btn-danger { background: #dc3545; color: white; }
    .btn-success { background: #28a745; color: white; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Finn Agent Jobs <span class="status-badge ${statusClass}">${overview.status.toUpperCase()}</span></h1>

    <div class="card">
      <h2>Kill Switch</h2>
      <form method="POST" action="/dashboard/kill-switch">
        <button type="submit" class="${overview.killSwitch ? "btn-success" : "btn-danger"}">
          ${overview.killSwitch ? "Deactivate Kill Switch" : "Activate Kill Switch"}
        </button>
      </form>
    </div>

    <div class="card">
      <h2>Jobs</h2>
      <div class="stats-grid">
        <div class="stat-item"><div class="stat-value">${overview.jobs.total}</div><div class="stat-label">Total</div></div>
        <div class="stat-item"><div class="stat-value">${overview.jobs.enabled}</div><div class="stat-label">Enabled</div></div>
        <div class="stat-item"><div class="stat-value">${overview.jobs.running}</div><div class="stat-label">Running</div></div>
        <div class="stat-item"><div class="stat-value">${overview.jobs.circuitOpen}</div><div class="stat-label">Circuit Open</div></div>
      </div>
    </div>

    <div class="card">
      <h2>Last 24 Hours</h2>
      <table>
        <thead>
          <tr><th>Metric</th><th>Value</th></tr>
        </thead>
        <tbody>
          <tr><td>Runs Total</td><td>${overview.last24h.runsTotal}</td></tr>
          <tr><td>Succeeded</td><td>${overview.last24h.runsSucceeded}</td></tr>
          <tr><td>Failed</td><td>${overview.last24h.runsFailed}</td></tr>
          <tr><td>GitHub HTTP Requests</td><td>${overview.last24h.githubHttpRequests}</td></tr>
          <tr><td>GitHub Mutations</td><td>${overview.last24h.githubMutations}</td></tr>
          <tr><td>Items Processed</td><td>${overview.last24h.itemsProcessed}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Rate Limits</h2>
      <p>GitHub API: ${overview.rateLimits.githubRemaining} remaining (resets ${escapeHtml(overview.rateLimits.githubResetAt)})</p>
      <div class="gauge">
        <div class="gauge-fill" style="width: ${ratePct}%; background: ${gaugeColor};"></div>
      </div>
    </div>

    <div class="card">
      <h2>Circuit Breakers</h2>
      <table>
        <thead>
          <tr><th>Job</th><th>State</th><th>Failures</th><th>Last Failure</th></tr>
        </thead>
        <tbody>${cbRows}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Audit Integrity</h2>
      <p class="${auditClass}">
        <span style="font-size: 1.5em;">${auditIcon}</span>
        Chain ${overview.auditIntegrity.chainValid ? "valid" : "BROKEN"}
        &mdash; ${overview.auditIntegrity.totalRecords} records
        (verified ${escapeHtml(overview.auditIntegrity.lastVerified)})
      </p>
    </div>

    <script>
      (function() {
        var ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '${wsEndpoint}');
        ws.onmessage = function() { setTimeout(function() { location.reload(); }, 500); };
        ws.onclose = function() { setTimeout(function() { location.reload(); }, 5000); };
      })();
    </script>
  </div>
</body>
</html>`
}

// ── Utility ──────────────────────────────────────────────────────

/** Timing-safe string comparison to prevent timing attacks on tokens. */
function safeCompare(a: string, b: string): boolean {
  const bufA = createHash("sha256").update(a).digest()
  const bufB = createHash("sha256").update(b).digest()
  return timingSafeEqual(bufA, bufB)
}
