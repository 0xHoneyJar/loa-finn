// src/gateway/dashboard-routes.ts — Dashboard Overview API (SDD §6.1, TASK-6.1)

import { createHash, timingSafeEqual } from "node:crypto"

// ── Request / Response types (same as CronApi) ──────────────

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

// ── Dependency interfaces (duck-typed for testability) ──────

export interface DashboardDeps {
  registry: {
    getJobs(): Array<{
      id: string
      enabled: boolean
      status: string
      circuitBreaker?: { state: string; failures: number; lastFailureAt?: string }
    }>
  }
  killSwitch: { isActive(): Promise<boolean> }
  auditTrail: {
    getRecords(opts: { since?: number; limit?: number }): Array<{
      action: string
      phase: string
      timestamp: number
      result?: { success?: boolean }
      metadata?: Record<string, unknown>
    }>
    verifyChain(): Promise<{ valid: boolean; brokenAt?: number }>
    getRecordCount(): number
  }
  rateLimiter?: { getStatus(): { remaining: number; resetAt: string } }
  authToken: string
}

// ── Dashboard overview shape ────────────────────────────────

export interface DashboardOverview {
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

// ── DashboardApi ────────────────────────────────────────────

/**
 * Framework-agnostic HTTP API for the dashboard overview endpoint.
 * Aggregates job registry, audit trail, and rate limit data into a
 * single snapshot response.
 */
export class DashboardApi {
  private readonly deps: DashboardDeps

  constructor(deps: DashboardDeps) {
    this.deps = deps
  }

  /** Dispatch a request through auth check + routing. */
  async handle(req: ApiRequest): Promise<ApiResponse> {
    const method = req.method.toUpperCase()
    const path = req.path

    if (method === "GET" && path === "/api/dashboard/overview") {
      const authErr = this.checkAuth(req)
      if (authErr) return authErr
      return this.getOverview()
    }

    return { status: 404, body: { error: "Not found", code: "ROUTE_NOT_FOUND" } }
  }

  // ── Auth ────────────────────────────────────────────────

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

  // ── Overview handler ────────────────────────────────────

  private async getOverview(): Promise<ApiResponse> {
    const jobs = this.deps.registry.getJobs()
    const killSwitchActive = await this.deps.killSwitch.isActive()

    // Job counts
    const total = jobs.length
    const enabled = jobs.filter((j) => j.enabled).length
    const running = jobs.filter((j) => j.status === "running").length
    const circuitOpen = jobs.filter((j) => j.circuitBreaker?.state === "open").length

    // Audit records from last 24h
    const since = Date.now() - 86_400_000
    const records = this.deps.auditTrail.getRecords({ since })

    // Aggregate run stats: runs are records where action contains "execute" or phase === "result"
    const runRecords = records.filter(
      (r) => r.action.includes("execute") || r.phase === "result",
    )
    const runsTotal = runRecords.length
    const runsSucceeded = runRecords.filter((r) => r.result?.success === true).length
    const runsFailed = runRecords.filter((r) => r.result?.success === false).length

    // GitHub stats from audit metadata
    const githubHttpRequests = records.filter((r) => r.action.startsWith("github:")).length
    const githubMutations = records.filter((r) => r.action === "github:mutation").length
    const itemsProcessed = records.reduce((sum, r) => {
      const count = r.metadata?.itemsProcessed
      return sum + (typeof count === "number" ? count : 0)
    }, 0)

    // Audit chain integrity
    const chainResult = await this.deps.auditTrail.verifyChain()
    const totalRecords = this.deps.auditTrail.getRecordCount()

    // Rate limits
    const rateLimitStatus = this.deps.rateLimiter?.getStatus()
    const githubRemaining = rateLimitStatus?.remaining ?? -1
    const githubResetAt = rateLimitStatus?.resetAt ?? "unknown"

    // Circuit breaker details
    const circuitBreakers = jobs
      .filter((j) => j.circuitBreaker)
      .map((j) => ({
        jobId: j.id,
        state: j.circuitBreaker!.state,
        failures: j.circuitBreaker!.failures,
        lastFailureAt: j.circuitBreaker!.lastFailureAt ?? null,
      }))

    // Status determination
    let status: DashboardOverview["status"] = "healthy"
    if (killSwitchActive) status = "stopped"
    else if (circuitOpen > 0) status = "degraded"

    const overview: DashboardOverview = {
      status,
      killSwitch: killSwitchActive,
      jobs: { total, enabled, running, circuitOpen },
      last24h: {
        runsTotal,
        runsSucceeded,
        runsFailed,
        githubHttpRequests,
        githubMutations,
        itemsProcessed,
      },
      rateLimits: { githubRemaining, githubResetAt },
      auditIntegrity: {
        lastVerified: new Date().toISOString(),
        chainValid: chainResult.valid,
        totalRecords,
      },
      circuitBreakers,
    }

    return { status: 200, body: overview }
  }
}

// ── Utility ─────────────────────────────────────────────────

/** Timing-safe string comparison to prevent timing attacks on tokens. */
function safeCompare(a: string, b: string): boolean {
  const bufA = createHash("sha256").update(a).digest()
  const bufB = createHash("sha256").update(b).digest()
  return timingSafeEqual(bufA, bufB)
}
