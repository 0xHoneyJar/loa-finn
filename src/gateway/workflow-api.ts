// src/gateway/workflow-api.ts — REST API for workflow run management (TASK-4.6)

import { createHash, timingSafeEqual } from "node:crypto"

// ── Request / Response types (same pattern as cron-api.ts) ──

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
  headers?: Record<string, string>
  body: unknown
}

// ── Workflow run record (duck-typed) ────────────────────────

export interface WorkflowRunRecord {
  id: string
  workflowId: string
  triggerId: string
  status: string
  currentStep: number
  steps: Array<{
    stepId: string
    status: string
    outputs: Record<string, unknown>
    error?: string
    durationMs?: number
  }>
  startedAt?: string
  completedAt?: string
  error?: string
}

// ── Persistence interface (duck-typed) ──────────────────────

export interface WorkflowApiPersistence {
  load(runId: string): Promise<WorkflowRunRecord | null>
  list(filter?: { workflowId?: string; status?: string }): Promise<WorkflowRunRecord[]>
}

// ── Approve/reject callback ─────────────────────────────────

export type ApprovalHandler = (runId: string, stepId: string, decision: "approve" | "reject") => Promise<boolean>

// ── Route matching ──────────────────────────────────────────

interface Route {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: (req: ApiRequest) => Promise<ApiResponse>
}

// ── WorkflowApi ─────────────────────────────────────────────

export class WorkflowApi {
  private readonly routes: Route[] = []
  private readonly persistence: WorkflowApiPersistence
  private readonly approvalHandler: ApprovalHandler
  private readonly authToken: string

  constructor(deps: {
    persistence: WorkflowApiPersistence
    approvalHandler: ApprovalHandler
    authToken: string
  }) {
    this.persistence = deps.persistence
    this.approvalHandler = deps.approvalHandler
    this.authToken = deps.authToken
    this.registerRoutes()
  }

  /** Dispatch a request through auth check + routing. */
  async handle(req: ApiRequest): Promise<ApiResponse> {
    const method = req.method.toUpperCase()
    const path = req.path

    for (const route of this.routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(path)
      if (!match) continue

      // Auth check (all workflow routes require auth)
      const authResult = this.checkAuth(req)
      if (authResult) return authResult

      // Extract path params
      const params: Record<string, string> = { ...req.params }
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = match[i + 1]
      }

      return route.handler({ ...req, method, params, query: req.query ?? {} })
    }

    return { status: 404, body: { error: "Not found", code: "ROUTE_NOT_FOUND" } }
  }

  // ── Auth ──────────────────────────────────────────────────

  private checkAuth(req: ApiRequest): ApiResponse | null {
    const authHeader = req.headers["authorization"] ?? req.headers["Authorization"]
    if (!authHeader?.startsWith("Bearer ")) {
      return { status: 401, body: { error: "Unauthorized", code: "AUTH_REQUIRED" } }
    }

    const token = authHeader.slice(7)
    if (!safeCompare(token, this.authToken)) {
      return { status: 401, body: { error: "Unauthorized", code: "AUTH_INVALID" } }
    }

    return null
  }

  // ── Route registration ────────────────────────────────────

  private registerRoutes(): void {
    this.route("GET", "/api/workflow/runs", (req) => this.listRuns(req))
    this.route("GET", "/api/workflow/runs/:id", (req) => this.getRun(req))
    this.route("POST", "/api/workflow/runs/:id/steps/:step/approve", (req) => this.approveStep(req))
  }

  private route(
    method: string,
    pathPattern: string,
    handler: (req: ApiRequest) => Promise<ApiResponse>,
  ): void {
    const paramNames: string[] = []
    const regexStr = pathPattern.replace(/:([a-zA-Z]+)/g, (_match, name) => {
      paramNames.push(name)
      return "([^/]+)"
    })
    this.routes.push({
      method,
      pattern: new RegExp(`^${regexStr}$`),
      paramNames,
      handler,
    })
  }

  // ── Handlers ──────────────────────────────────────────────

  private async listRuns(req: ApiRequest): Promise<ApiResponse> {
    const filter: { workflowId?: string; status?: string } = {}
    if (req.query?.workflowId) filter.workflowId = req.query.workflowId
    if (req.query?.status) filter.status = req.query.status

    const runs = await this.persistence.list(Object.keys(filter).length > 0 ? filter : undefined)
    return { status: 200, body: { runs } }
  }

  private async getRun(req: ApiRequest): Promise<ApiResponse> {
    const id = req.params!["id"]
    const run = await this.persistence.load(id)
    if (!run) {
      return { status: 404, body: { error: "Run not found", code: "RUN_NOT_FOUND" } }
    }
    return { status: 200, body: { run } }
  }

  private async approveStep(req: ApiRequest): Promise<ApiResponse> {
    const id = req.params!["id"]
    const step = req.params!["step"]
    const body = req.body as { decision?: "approve" | "reject" } | undefined
    const decision = body?.decision ?? "approve"

    const ok = await this.approvalHandler(id, step, decision)
    if (!ok) {
      return { status: 404, body: { error: "Run or step not found", code: "NOT_FOUND" } }
    }
    return { status: 200, body: { approved: true, runId: id, stepId: step, decision } }
  }
}

// ── Utility ─────────────────────────────────────────────────

/** Timing-safe string comparison to prevent timing attacks on tokens. */
function safeCompare(a: string, b: string): boolean {
  const bufA = createHash("sha256").update(a).digest()
  const bufB = createHash("sha256").update(b).digest()
  return timingSafeEqual(bufA, bufB)
}
