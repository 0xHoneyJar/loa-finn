// tests/finn/workflow-api.test.ts — WorkflowApi route handler tests (TASK-4.6)
// Self-contained: all types and WorkflowApi class inlined.

import assert from "node:assert/strict"
import { createHash, timingSafeEqual } from "node:crypto"

// ── Inlined types ────────────────────────────────────────────

interface ApiRequest {
  method: string
  path: string
  headers: Record<string, string>
  body?: unknown
  params?: Record<string, string>
  query?: Record<string, string>
}

interface ApiResponse {
  status: number
  headers?: Record<string, string>
  body: unknown
}

interface WorkflowRunRecord {
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

interface WorkflowApiPersistence {
  load(runId: string): Promise<WorkflowRunRecord | null>
  list(filter?: { workflowId?: string; status?: string }): Promise<WorkflowRunRecord[]>
}

type ApprovalHandler = (runId: string, stepId: string, decision: "approve" | "reject") => Promise<boolean>

// ── Inlined WorkflowApi ──────────────────────────────────────

interface Route {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: (req: ApiRequest) => Promise<ApiResponse>
}

function safeCompare(a: string, b: string): boolean {
  const bufA = createHash("sha256").update(a).digest()
  const bufB = createHash("sha256").update(b).digest()
  return timingSafeEqual(bufA, bufB)
}

class WorkflowApi {
  private readonly routes: Route[] = []
  private readonly persistence: WorkflowApiPersistence
  private readonly approvalHandler: ApprovalHandler
  private readonly authToken: string

  constructor(deps: { persistence: WorkflowApiPersistence; approvalHandler: ApprovalHandler; authToken: string }) {
    this.persistence = deps.persistence
    this.approvalHandler = deps.approvalHandler
    this.authToken = deps.authToken
    this.registerRoutes()
  }

  async handle(req: ApiRequest): Promise<ApiResponse> {
    const method = req.method.toUpperCase()
    const path = req.path
    for (const route of this.routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(path)
      if (!match) continue
      const authHeader = req.headers["authorization"] ?? req.headers["Authorization"]
      if (!authHeader?.startsWith("Bearer ")) {
        return { status: 401, body: { error: "Unauthorized", code: "AUTH_REQUIRED" } }
      }
      const token = authHeader.slice(7)
      if (!safeCompare(token, this.authToken)) {
        return { status: 401, body: { error: "Unauthorized", code: "AUTH_INVALID" } }
      }
      const params: Record<string, string> = { ...req.params }
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = match[i + 1]
      }
      return route.handler({ ...req, method, params, query: req.query ?? {} })
    }
    return { status: 404, body: { error: "Not found", code: "ROUTE_NOT_FOUND" } }
  }

  private registerRoutes(): void {
    this.route("GET", "/api/workflow/runs", (r) => this.listRuns(r))
    this.route("GET", "/api/workflow/runs/:id", (r) => this.getRun(r))
    this.route("POST", "/api/workflow/runs/:id/steps/:step/approve", (r) => this.approveStep(r))
  }

  private route(method: string, pathPattern: string, handler: (req: ApiRequest) => Promise<ApiResponse>): void {
    const paramNames: string[] = []
    const regexStr = pathPattern.replace(/:([a-zA-Z]+)/g, (_m, name) => { paramNames.push(name); return "([^/]+)" })
    this.routes.push({ method, pattern: new RegExp(`^${regexStr}$`), paramNames, handler })
  }

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
    if (!run) return { status: 404, body: { error: "Run not found", code: "RUN_NOT_FOUND" } }
    return { status: 200, body: { run } }
  }

  private async approveStep(req: ApiRequest): Promise<ApiResponse> {
    const id = req.params!["id"]
    const step = req.params!["step"]
    const body = req.body as { decision?: "approve" | "reject" } | undefined
    const decision = body?.decision ?? "approve"
    const ok = await this.approvalHandler(id, step, decision)
    if (!ok) return { status: 404, body: { error: "Run or step not found", code: "NOT_FOUND" } }
    return { status: 200, body: { approved: true, runId: id, stepId: step, decision } }
  }
}

// ── Test harness ─────────────────────────────────────────────

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, fn }) }

// ── Mock helpers ─────────────────────────────────────────────

const AUTH_TOKEN = "wf-test-secret-42"

function makeRun(overrides: Partial<WorkflowRunRecord> & { id: string }): WorkflowRunRecord {
  return {
    workflowId: "wf-default",
    triggerId: "trig-1",
    status: "pending",
    currentStep: 0,
    steps: [],
    ...overrides,
  }
}

function makePersistence(runs: WorkflowRunRecord[]): WorkflowApiPersistence {
  const store = new Map<string, WorkflowRunRecord>()
  for (const r of runs) store.set(r.id, r)
  return {
    async load(runId) { return store.get(runId) ?? null },
    async list(filter?) {
      let results = Array.from(store.values())
      if (filter?.workflowId) results = results.filter(r => r.workflowId === filter.workflowId)
      if (filter?.status) results = results.filter(r => r.status === filter.status)
      return results
    },
  }
}

function req(method: string, path: string, opts?: {
  body?: unknown
  token?: string | null
  query?: Record<string, string>
}): ApiRequest {
  const headers: Record<string, string> = {}
  if (opts?.token !== null && opts?.token !== undefined) {
    headers["authorization"] = `Bearer ${opts.token}`
  } else if (opts?.token === undefined) {
    headers["authorization"] = `Bearer ${AUTH_TOKEN}`
  }
  return { method, path, headers, body: opts?.body, query: opts?.query }
}

// ── Tests ────────────────────────────────────────────────────

test("GET /api/workflow/runs: lists all runs", async () => {
  const runs = [makeRun({ id: "r1" }), makeRun({ id: "r2" })]
  const api = new WorkflowApi({ persistence: makePersistence(runs), approvalHandler: async () => true, authToken: AUTH_TOKEN })
  const res = await api.handle(req("GET", "/api/workflow/runs"))
  assert.equal(res.status, 200)
  const body = res.body as any
  assert.equal(body.runs.length, 2)
})

test("GET /api/workflow/runs: filters by workflowId", async () => {
  const runs = [
    makeRun({ id: "r1", workflowId: "wf-a" }),
    makeRun({ id: "r2", workflowId: "wf-b" }),
    makeRun({ id: "r3", workflowId: "wf-a" }),
  ]
  const api = new WorkflowApi({ persistence: makePersistence(runs), approvalHandler: async () => true, authToken: AUTH_TOKEN })
  const res = await api.handle(req("GET", "/api/workflow/runs", { query: { workflowId: "wf-a" } }))
  assert.equal(res.status, 200)
  const body = res.body as any
  assert.equal(body.runs.length, 2)
  assert.ok(body.runs.every((r: any) => r.workflowId === "wf-a"))
})

test("GET /api/workflow/runs/:id: returns run details", async () => {
  const run = makeRun({
    id: "run-42",
    workflowId: "wf-deploy",
    status: "running",
    steps: [{ stepId: "build", status: "completed", outputs: { artifact: "app.zip" }, durationMs: 300 }],
  })
  const api = new WorkflowApi({ persistence: makePersistence([run]), approvalHandler: async () => true, authToken: AUTH_TOKEN })
  const res = await api.handle(req("GET", "/api/workflow/runs/run-42"))
  assert.equal(res.status, 200)
  const body = res.body as any
  assert.equal(body.run.id, "run-42")
  assert.equal(body.run.steps.length, 1)
  assert.equal(body.run.steps[0].stepId, "build")
})

test("GET /api/workflow/runs/:id: 404 for unknown", async () => {
  const api = new WorkflowApi({ persistence: makePersistence([]), approvalHandler: async () => true, authToken: AUTH_TOKEN })
  const res = await api.handle(req("GET", "/api/workflow/runs/nonexistent"))
  assert.equal(res.status, 404)
  assert.equal((res.body as any).code, "RUN_NOT_FOUND")
})

test("POST approve: approves a step", async () => {
  const calls: { runId: string; stepId: string; decision: string }[] = []
  const handler: ApprovalHandler = async (runId, stepId, decision) => {
    calls.push({ runId, stepId, decision })
    return true
  }
  const api = new WorkflowApi({ persistence: makePersistence([]), approvalHandler: handler, authToken: AUTH_TOKEN })
  const res = await api.handle(req("POST", "/api/workflow/runs/run-1/steps/step-review/approve", {
    body: { decision: "approve" },
  }))
  assert.equal(res.status, 200)
  const body = res.body as any
  assert.equal(body.decision, "approve")
  assert.equal(body.runId, "run-1")
  assert.equal(body.stepId, "step-review")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].decision, "approve")
})

test("POST approve: rejects a step", async () => {
  const calls: { runId: string; stepId: string; decision: string }[] = []
  const handler: ApprovalHandler = async (runId, stepId, decision) => {
    calls.push({ runId, stepId, decision })
    return true
  }
  const api = new WorkflowApi({ persistence: makePersistence([]), approvalHandler: handler, authToken: AUTH_TOKEN })
  const res = await api.handle(req("POST", "/api/workflow/runs/run-1/steps/step-review/approve", {
    body: { decision: "reject" },
  }))
  assert.equal(res.status, 200)
  assert.equal((res.body as any).decision, "reject")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].decision, "reject")
})

test("POST approve: 404 when handler returns false", async () => {
  const handler: ApprovalHandler = async () => false
  const api = new WorkflowApi({ persistence: makePersistence([]), approvalHandler: handler, authToken: AUTH_TOKEN })
  const res = await api.handle(req("POST", "/api/workflow/runs/run-x/steps/step-x/approve", {
    body: { decision: "approve" },
  }))
  assert.equal(res.status, 404)
  assert.equal((res.body as any).code, "NOT_FOUND")
})

test("auth: 401 without token", async () => {
  const api = new WorkflowApi({ persistence: makePersistence([]), approvalHandler: async () => true, authToken: AUTH_TOKEN })
  const res = await api.handle(req("GET", "/api/workflow/runs", { token: null }))
  assert.equal(res.status, 401)
  assert.equal((res.body as any).code, "AUTH_REQUIRED")
})

test("auth: 401 with wrong token", async () => {
  const api = new WorkflowApi({ persistence: makePersistence([]), approvalHandler: async () => true, authToken: AUTH_TOKEN })
  const res = await api.handle(req("GET", "/api/workflow/runs", { token: "wrong-token" }))
  assert.equal(res.status, 401)
  assert.equal((res.body as any).code, "AUTH_INVALID")
})

test("unknown route: returns 404", async () => {
  const api = new WorkflowApi({ persistence: makePersistence([]), approvalHandler: async () => true, authToken: AUTH_TOKEN })
  const res = await api.handle(req("GET", "/api/workflow/unknown"))
  assert.equal(res.status, 404)
  assert.equal((res.body as any).code, "ROUTE_NOT_FOUND")
})

// ── Runner ───────────────────────────────────────────────────

async function main() {
  console.log("WorkflowApi Tests")
  console.log("=================")
  let passed = 0
  let failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      passed++
      console.log(`  PASS  ${t.name}`)
    } catch (err: unknown) {
      failed++
      console.error(`  FAIL  ${t.name}`)
      console.error(`    ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
