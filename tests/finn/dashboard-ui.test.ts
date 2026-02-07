// tests/finn/dashboard-ui.test.ts — Dashboard UI server-rendered HTML tests (TASK-6.5)

import assert from "node:assert/strict"
import { Dashboard } from "../../src/gateway/dashboard.js"
import type { ApiRequest, ApiResponse, DashboardUIDeps } from "../../src/gateway/dashboard.js"

// ── Test harness ────────────────────────────────────────────────

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Mock factories ──────────────────────────────────────────────

const AUTH_TOKEN = "ui-secret-42"

function makeOverview(overrides?: Partial<{
  status: "healthy" | "degraded" | "stopped"
  killSwitch: boolean
  jobs: { total: number; enabled: number; running: number; circuitOpen: number }
  circuitBreakers: Array<{ jobId: string; state: string; failures: number; lastFailureAt: string | null }>
}>) {
  return {
    status: overrides?.status ?? "healthy",
    killSwitch: overrides?.killSwitch ?? false,
    jobs: overrides?.jobs ?? { total: 3, enabled: 2, running: 1, circuitOpen: 0 },
    last24h: {
      runsTotal: 10, runsSucceeded: 8, runsFailed: 2,
      githubHttpRequests: 50, githubMutations: 5, itemsProcessed: 30,
    },
    rateLimits: { githubRemaining: 4500, githubResetAt: "2026-02-07T12:00:00Z" },
    auditIntegrity: { lastVerified: "2026-02-07T11:00:00Z", chainValid: true, totalRecords: 100 },
    circuitBreakers: overrides?.circuitBreakers ?? [],
  }
}

function makeDeps(overview?: ReturnType<typeof makeOverview>): DashboardUIDeps {
  const data = overview ?? makeOverview()
  return {
    overviewApi: {
      async handle(req: ApiRequest): Promise<ApiResponse> {
        // Require auth like the real API
        const auth = req.headers["authorization"] ?? req.headers["Authorization"]
        if (!auth?.startsWith("Bearer ")) {
          return { status: 401, body: { error: "Unauthorized", code: "AUTH_REQUIRED" } }
        }
        const token = auth.slice(7)
        if (token !== AUTH_TOKEN) {
          return { status: 401, body: { error: "Unauthorized", code: "AUTH_INVALID" } }
        }
        return { status: 200, body: data }
      },
    },
    authToken: AUTH_TOKEN,
  }
}

function req(method: string, path: string, opts?: { token?: string | null }): ApiRequest {
  const headers: Record<string, string> = {}
  if (opts?.token !== null && opts?.token !== undefined) {
    headers["authorization"] = `Bearer ${opts.token}`
  } else if (opts?.token === undefined) {
    headers["authorization"] = `Bearer ${AUTH_TOKEN}`
  }
  return { method, path, headers }
}

// ── Tests ───────────────────────────────────────────────────────

test("GET /dashboard returns HTML with status badge", async () => {
  const dashboard = new Dashboard(makeDeps())
  const res = await dashboard.handle(req("GET", "/dashboard"))
  assert.equal(res.status, 200)
  const html = res.body as string
  assert.ok(html.includes("<!DOCTYPE html>"), "should be full HTML document")
  assert.ok(html.includes("status-badge"), "should contain status badge")
  assert.ok(html.includes("Finn Agent Jobs"), "should contain title")
})

test("GET /dashboard contains kill switch form", async () => {
  const dashboard = new Dashboard(makeDeps())
  const res = await dashboard.handle(req("GET", "/dashboard"))
  const html = res.body as string
  assert.ok(html.includes('action="/dashboard/kill-switch"'), "should contain kill switch form action")
  assert.ok(html.includes('method="POST"'), "should use POST method")
  assert.ok(html.includes("Activate Kill Switch"), "should show activate button when inactive")
})

test("GET /dashboard shows job counts", async () => {
  const overview = makeOverview({ jobs: { total: 5, enabled: 4, running: 2, circuitOpen: 1 } })
  const dashboard = new Dashboard(makeDeps(overview))
  const res = await dashboard.handle(req("GET", "/dashboard"))
  const html = res.body as string
  // Check that job count values appear in stat items
  assert.ok(html.includes(">5</div>"), "should show total jobs")
  assert.ok(html.includes(">4</div>"), "should show enabled jobs")
  assert.ok(html.includes(">2</div>"), "should show running jobs")
})

test("GET /dashboard shows circuit breakers", async () => {
  const overview = makeOverview({
    circuitBreakers: [
      { jobId: "stale-cleanup", state: "open", failures: 3, lastFailureAt: "2026-02-07T10:00:00Z" },
      { jobId: "pr-review", state: "closed", failures: 0, lastFailureAt: null },
    ],
  })
  const dashboard = new Dashboard(makeDeps(overview))
  const res = await dashboard.handle(req("GET", "/dashboard"))
  const html = res.body as string
  assert.ok(html.includes("stale-cleanup"), "should list stale-cleanup job")
  assert.ok(html.includes("pr-review"), "should list pr-review job")
  assert.ok(html.includes("status-cb-open"), "should show open state badge")
  assert.ok(html.includes("status-cb-closed"), "should show closed state badge")
})

test("HTML contains WebSocket script", async () => {
  const dashboard = new Dashboard(makeDeps())
  const res = await dashboard.handle(req("GET", "/dashboard"))
  const html = res.body as string
  assert.ok(html.includes("new WebSocket"), "should contain WebSocket constructor")
  assert.ok(html.includes("ws.onmessage"), "should have onmessage handler")
  assert.ok(html.includes("ws.onclose"), "should have onclose handler")
  assert.ok(html.includes("'/ws'"), "should use default /ws endpoint")
})

test("status-healthy class applied when healthy", async () => {
  const overview = makeOverview({ status: "healthy" })
  const dashboard = new Dashboard(makeDeps(overview))
  const res = await dashboard.handle(req("GET", "/dashboard"))
  const html = res.body as string
  assert.ok(html.includes("status-healthy"), "should contain status-healthy class")
  assert.ok(html.includes("HEALTHY"), "should show HEALTHY text")
})

test("status-stopped class applied when kill switch active", async () => {
  const overview = makeOverview({ status: "stopped", killSwitch: true })
  const dashboard = new Dashboard(makeDeps(overview))
  const res = await dashboard.handle(req("GET", "/dashboard"))
  const html = res.body as string
  assert.ok(html.includes("status-stopped"), "should contain status-stopped class")
  assert.ok(html.includes("STOPPED"), "should show STOPPED text")
  assert.ok(html.includes("Deactivate Kill Switch"), "should show deactivate button")
  assert.ok(html.includes("btn-success"), "should use success button style for deactivate")
})

test("POST /dashboard/kill-switch requires auth (401 without token)", async () => {
  const dashboard = new Dashboard(makeDeps())
  const res = await dashboard.handle(req("POST", "/dashboard/kill-switch", { token: null }))
  assert.equal(res.status, 401)
  assert.equal((res.body as any).code, "AUTH_REQUIRED")
})

test("route not found returns 404", async () => {
  const dashboard = new Dashboard(makeDeps())
  const res = await dashboard.handle(req("GET", "/dashboard/nonexistent"))
  assert.equal(res.status, 404)
  assert.equal((res.body as any).code, "ROUTE_NOT_FOUND")
})

// ── Runner ──────────────────────────────────────────────────────

async function main() {
  console.log("Dashboard UI Tests")
  console.log("==================")
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
