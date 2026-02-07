// src/gateway/cron-api.ts — HTTP API router for cron job lifecycle management (SDD §3.2, TASK-3.6)

import { createHash, timingSafeEqual } from "node:crypto"

// ── Dependency interfaces (duck-typed for testability) ────────

export interface CronServiceLike {
  createJob(job: any): Promise<any>
  updateJob(id: string, updates: any): Promise<boolean>
  deleteJob(id: string): Promise<boolean>
  triggerJob(id: string): Promise<boolean>
}

export interface KillSwitchLike {
  activate(): Promise<string[]>
  deactivate(): Promise<void>
  isActive(): Promise<boolean>
}

export interface JobRegistryLike {
  getJobs(): any[]
  getJob(id: string): any | undefined
}

export interface CronApiDeps {
  cronService: CronServiceLike
  killSwitch: KillSwitchLike
  registry: JobRegistryLike
  authToken: string
}

// ── Request / Response types ──────────────────────────────────

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

// ── Route matching ────────────────────────────────────────────

interface Route {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: (req: ApiRequest) => Promise<ApiResponse>
  requiresAuth: boolean
}

// ── CronApi ───────────────────────────────────────────────────

/**
 * Framework-agnostic HTTP API for cron job management.
 * Accepts structured requests, returns structured responses.
 * Auth, routing, and validation are handled internally.
 */
export class CronApi {
  private readonly routes: Route[] = []
  private readonly deps: CronApiDeps

  constructor(deps: CronApiDeps) {
    this.deps = deps
    this.registerRoutes()
  }

  /** Dispatch a request through auth check + routing. */
  async handle(req: ApiRequest): Promise<ApiResponse> {
    // Normalize method
    const method = req.method.toUpperCase()
    const path = req.path

    // Find matching route
    for (const route of this.routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(path)
      if (!match) continue

      // Extract path params
      const params: Record<string, string> = { ...req.params }
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = match[i + 1]
      }

      // Auth check for protected routes
      if (route.requiresAuth) {
        const authResult = this.checkAuth(req)
        if (authResult) return authResult
      }

      return route.handler({ ...req, method, params, query: req.query ?? {} })
    }

    return { status: 404, body: { error: "Not found", code: "ROUTE_NOT_FOUND" } }
  }

  // ── Auth ──────────────────────────────────────────────────

  /** Returns an error response if auth fails, or null if auth passes. */
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

  // ── Route registration ────────────────────────────────────

  private registerRoutes(): void {
    // POST /api/cron/jobs — create job
    this.route("POST", "/api/cron/jobs", true, (req) => this.createJob(req))

    // GET /api/cron/jobs — list jobs (read-only, no auth required)
    this.route("GET", "/api/cron/jobs", false, (req) => this.listJobs(req))

    // PATCH /api/cron/jobs/:id — update job
    this.route("PATCH", "/api/cron/jobs/:id", true, (req) => this.updateJob(req))

    // DELETE /api/cron/jobs/:id — delete job
    this.route("DELETE", "/api/cron/jobs/:id", true, (req) => this.deleteJob(req))

    // POST /api/cron/jobs/:id/trigger — manual trigger
    this.route("POST", "/api/cron/jobs/:id/trigger", true, (req) => this.triggerJob(req))

    // GET /api/cron/jobs/:id/logs — paginated run history (read-only)
    this.route("GET", "/api/cron/jobs/:id/logs", false, (req) => this.getJobLogs(req))

    // POST /api/cron/kill-switch — kill switch control
    this.route("POST", "/api/cron/kill-switch", true, (req) => this.killSwitch(req))
  }

  /** Register a route with path-param extraction. */
  private route(
    method: string,
    pathPattern: string,
    requiresAuth: boolean,
    handler: (req: ApiRequest) => Promise<ApiResponse>,
  ): void {
    const paramNames: string[] = []
    // Convert /api/cron/jobs/:id to /api/cron/jobs/([^/]+)
    const regexStr = pathPattern.replace(/:([a-zA-Z]+)/g, (_match, name) => {
      paramNames.push(name)
      return "([^/]+)"
    })
    this.routes.push({
      method,
      pattern: new RegExp(`^${regexStr}$`),
      paramNames,
      handler,
      requiresAuth,
    })
  }

  // ── Handlers ──────────────────────────────────────────────

  private async createJob(req: ApiRequest): Promise<ApiResponse> {
    const body = req.body as Record<string, unknown> | undefined
    if (!body || typeof body !== "object") {
      return { status: 400, body: { error: "Request body required", code: "INVALID_REQUEST" } }
    }

    // Validate required fields
    const { templateId, name, schedule } = body as {
      templateId?: string
      name?: string
      schedule?: { kind?: string; expression?: string }
    }

    if (!templateId || typeof templateId !== "string") {
      return { status: 400, body: { error: "templateId is required", code: "VALIDATION_ERROR" } }
    }
    if (!name || typeof name !== "string") {
      return { status: 400, body: { error: "name is required", code: "VALIDATION_ERROR" } }
    }
    if (!schedule || !schedule.kind || !schedule.expression) {
      return { status: 400, body: { error: "schedule (kind + expression) is required", code: "VALIDATION_ERROR" } }
    }

    const job = await this.deps.cronService.createJob(body)
    return { status: 201, body: { job } }
  }

  private async listJobs(_req: ApiRequest): Promise<ApiResponse> {
    const jobs = this.deps.registry.getJobs()
    return { status: 200, body: { jobs } }
  }

  private async updateJob(req: ApiRequest): Promise<ApiResponse> {
    const id = req.params!["id"]
    const body = req.body as Record<string, unknown> | undefined
    if (!body || typeof body !== "object") {
      return { status: 400, body: { error: "Request body required", code: "INVALID_REQUEST" } }
    }

    const ok = await this.deps.cronService.updateJob(id, body)
    if (!ok) {
      return { status: 404, body: { error: "Job not found", code: "JOB_NOT_FOUND" } }
    }

    const updated = this.deps.registry.getJob(id)
    return { status: 200, body: { job: updated } }
  }

  private async deleteJob(req: ApiRequest): Promise<ApiResponse> {
    const id = req.params!["id"]
    const ok = await this.deps.cronService.deleteJob(id)
    if (!ok) {
      return { status: 404, body: { error: "Job not found", code: "JOB_NOT_FOUND" } }
    }
    return { status: 200, body: { deleted: true, id } }
  }

  private async triggerJob(req: ApiRequest): Promise<ApiResponse> {
    const id = req.params!["id"]
    const ok = await this.deps.cronService.triggerJob(id)
    if (!ok) {
      return { status: 404, body: { error: "Job not found", code: "JOB_NOT_FOUND" } }
    }
    return { status: 200, body: { triggered: true, id } }
  }

  private async getJobLogs(req: ApiRequest): Promise<ApiResponse> {
    const id = req.params!["id"]
    const job = this.deps.registry.getJob(id)
    if (!job) {
      return { status: 404, body: { error: "Job not found", code: "JOB_NOT_FOUND" } }
    }

    // Pagination params
    const limit = Math.min(parseInt(req.query?.["limit"] ?? "50", 10) || 50, 200)
    const offset = parseInt(req.query?.["offset"] ?? "0", 10) || 0

    // Logs are stored as JSONL files in the registry's runs dir.
    // Since we don't have direct file access here (framework-agnostic),
    // return job metadata with pagination hints. The actual JSONL reading
    // will be wired when the Hono routes integrate this class.
    return {
      status: 200,
      body: {
        jobId: id,
        logs: [],
        pagination: { limit, offset, total: 0 },
      },
    }
  }

  private async killSwitch(req: ApiRequest): Promise<ApiResponse> {
    const body = req.body as { action?: string } | undefined
    const action = body?.action ?? "activate"

    if (action === "deactivate") {
      await this.deps.killSwitch.deactivate()
      return {
        status: 200,
        body: { active: false, message: "Kill switch deactivated" },
      }
    }

    // Default: activate
    const stoppedJobs = await this.deps.killSwitch.activate()
    return {
      status: 200,
      body: { active: true, stoppedJobs, message: "Kill switch activated" },
    }
  }
}

// ── Utility ─────────────────────────────────────────────────

/** Timing-safe string comparison to prevent timing attacks on tokens. */
function safeCompare(a: string, b: string): boolean {
  const bufA = createHash("sha256").update(a).digest()
  const bufB = createHash("sha256").update(b).digest()
  return timingSafeEqual(bufA, bufB)
}
