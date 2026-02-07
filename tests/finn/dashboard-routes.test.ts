// tests/finn/dashboard-routes.test.ts — DashboardApi route handler tests (TASK-6.1)

import assert from "node:assert/strict"
import { DashboardApi } from "../../src/gateway/dashboard-routes.js"
import type { DashboardDeps, ApiRequest } from "../../src/gateway/dashboard-routes.js"

// ── Test harness ────────────────────────────────────────────

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Mock factories ──────────────────────────────────────────

const AUTH_TOKEN = "dashboard-secret-42"

function makeMocks(overrides?: {
  killSwitchActive?: boolean
  chainValid?: boolean
  rateLimiter?: { remaining: number; resetAt: string } | null
}) {
  const jobs: Array<{
    id: string; enabled: boolean; status: string
    circuitBreaker?: { state: string; failures: number; lastFailureAt?: string }
  }> = []

  const auditRecords: Array<{
    action: string; phase: string; timestamp: number
    result?: { success?: boolean }; metadata?: Record<string, unknown>
  }> = []

  let killSwitchActive = overrides?.killSwitchActive ?? false
  const chainValid = overrides?.chainValid ?? true

  const registry = {
    getJobs() { return jobs },
  }

  const killSwitch = {
    async isActive() { return killSwitchActive },
    setActive(v: boolean) { killSwitchActive = v },
  }

  const auditTrail = {
    getRecords(opts: { since?: number; limit?: number }) {
      if (opts.since != null) {
        return auditRecords.filter((r) => r.timestamp >= opts.since!)
      }
      return auditRecords
    },
    async verifyChain() { return { valid: chainValid } },
    getRecordCount() { return auditRecords.length },
  }

  const rateLimiter = overrides?.rateLimiter === null
    ? undefined
    : { getStatus() { return overrides?.rateLimiter ?? { remaining: 4500, resetAt: "2026-02-07T12:00:00Z" } } }

  return { registry, killSwitch, auditTrail, rateLimiter, jobs, auditRecords }
}

function makeDeps(mocks: ReturnType<typeof makeMocks>): DashboardDeps {
  return {
    registry: mocks.registry,
    killSwitch: mocks.killSwitch,
    auditTrail: mocks.auditTrail,
    rateLimiter: mocks.rateLimiter,
    authToken: AUTH_TOKEN,
  }
}

function req(method: string, path: string, opts?: {
  token?: string | null
}): ApiRequest {
  const headers: Record<string, string> = {}
  if (opts?.token !== null && opts?.token !== undefined) {
    headers["authorization"] = `Bearer ${opts.token}`
  } else if (opts?.token === undefined) {
    headers["authorization"] = `Bearer ${AUTH_TOKEN}`
  }
  return { method, path, headers }
}

// ── Tests ───────────────────────────────────────────────────

test("overview returns healthy status when all good", async () => {
  const mocks = makeMocks()
  mocks.jobs.push({ id: "j1", enabled: true, status: "idle" })
  const api = new DashboardApi(makeDeps(mocks))
  const res = await api.handle(req("GET", "/api/dashboard/overview"))
  assert.equal(res.status, 200)
  const body = res.body as any
  assert.equal(body.status, "healthy")
  assert.equal(body.killSwitch, false)
})

test("overview returns stopped when kill switch active", async () => {
  const mocks = makeMocks({ killSwitchActive: true })
  mocks.jobs.push({ id: "j1", enabled: true, status: "idle" })
  const api = new DashboardApi(makeDeps(mocks))
  const res = await api.handle(req("GET", "/api/dashboard/overview"))
  const body = res.body as any
  assert.equal(body.status, "stopped")
  assert.equal(body.killSwitch, true)
})

test("overview returns degraded when circuit breaker open", async () => {
  const mocks = makeMocks()
  mocks.jobs.push({
    id: "j1", enabled: true, status: "idle",
    circuitBreaker: { state: "open", failures: 3, lastFailureAt: "2026-02-07T10:00:00Z" },
  })
  mocks.jobs.push({ id: "j2", enabled: true, status: "idle" })
  const api = new DashboardApi(makeDeps(mocks))
  const res = await api.handle(req("GET", "/api/dashboard/overview"))
  const body = res.body as any
  assert.equal(body.status, "degraded")
})

test("jobs counts correct (total, enabled, running, circuitOpen)", async () => {
  const mocks = makeMocks()
  mocks.jobs.push({ id: "j1", enabled: true, status: "running" })
  mocks.jobs.push({ id: "j2", enabled: false, status: "idle" })
  mocks.jobs.push({
    id: "j3", enabled: true, status: "idle",
    circuitBreaker: { state: "open", failures: 5 },
  })
  mocks.jobs.push({
    id: "j4", enabled: true, status: "running",
    circuitBreaker: { state: "closed", failures: 0 },
  })
  const api = new DashboardApi(makeDeps(mocks))
  const res = await api.handle(req("GET", "/api/dashboard/overview"))
  const body = res.body as any
  assert.equal(body.jobs.total, 4)
  assert.equal(body.jobs.enabled, 3)
  assert.equal(body.jobs.running, 2)
  assert.equal(body.jobs.circuitOpen, 1)
})

test("last24h aggregation from audit records", async () => {
  const mocks = makeMocks()
  const now = Date.now()
  // Recent records (within 24h)
  mocks.auditRecords.push(
    { action: "job:execute", phase: "start", timestamp: now - 1000, result: { success: true } },
    { action: "job:execute", phase: "result", timestamp: now - 900, result: { success: true } },
    { action: "job:execute", phase: "result", timestamp: now - 800, result: { success: false } },
    { action: "github:mutation", phase: "call", timestamp: now - 700, metadata: { itemsProcessed: 3 } },
    { action: "github:read", phase: "call", timestamp: now - 600, metadata: { itemsProcessed: 5 } },
  )
  // Old record (outside 24h window)
  mocks.auditRecords.push(
    { action: "job:execute", phase: "result", timestamp: now - 90_000_000, result: { success: true } },
  )
  const api = new DashboardApi(makeDeps(mocks))
  const res = await api.handle(req("GET", "/api/dashboard/overview"))
  const body = res.body as any
  // "execute" actions: 3 recent records match (action contains "execute")
  assert.equal(body.last24h.runsTotal, 3)
  assert.equal(body.last24h.runsSucceeded, 2)
  assert.equal(body.last24h.runsFailed, 1)
  // github: prefix matches both github:mutation and github:read
  assert.equal(body.last24h.githubHttpRequests, 2)
  assert.equal(body.last24h.githubMutations, 1)
  assert.equal(body.last24h.itemsProcessed, 8)
})

test("audit integrity included", async () => {
  const mocks = makeMocks({ chainValid: true })
  mocks.auditRecords.push(
    { action: "test", phase: "x", timestamp: Date.now() },
    { action: "test", phase: "x", timestamp: Date.now() },
  )
  const api = new DashboardApi(makeDeps(mocks))
  const res = await api.handle(req("GET", "/api/dashboard/overview"))
  const body = res.body as any
  assert.equal(body.auditIntegrity.chainValid, true)
  assert.equal(body.auditIntegrity.totalRecords, 2)
  assert.ok(typeof body.auditIntegrity.lastVerified === "string")
})

test("circuit breakers list populated", async () => {
  const mocks = makeMocks()
  mocks.jobs.push({
    id: "j1", enabled: true, status: "idle",
    circuitBreaker: { state: "open", failures: 3, lastFailureAt: "2026-02-07T10:00:00Z" },
  })
  mocks.jobs.push({
    id: "j2", enabled: true, status: "idle",
    circuitBreaker: { state: "closed", failures: 0 },
  })
  mocks.jobs.push({ id: "j3", enabled: true, status: "idle" })
  const api = new DashboardApi(makeDeps(mocks))
  const res = await api.handle(req("GET", "/api/dashboard/overview"))
  const body = res.body as any
  assert.equal(body.circuitBreakers.length, 2)
  assert.equal(body.circuitBreakers[0].jobId, "j1")
  assert.equal(body.circuitBreakers[0].state, "open")
  assert.equal(body.circuitBreakers[0].failures, 3)
  assert.equal(body.circuitBreakers[0].lastFailureAt, "2026-02-07T10:00:00Z")
  assert.equal(body.circuitBreakers[1].jobId, "j2")
  assert.equal(body.circuitBreakers[1].lastFailureAt, null)
})

test("auth required (401 without token)", async () => {
  const mocks = makeMocks()
  const api = new DashboardApi(makeDeps(mocks))
  const res = await api.handle(req("GET", "/api/dashboard/overview", { token: null }))
  assert.equal(res.status, 401)
  assert.equal((res.body as any).code, "AUTH_REQUIRED")
})

test("auth invalid (401 with wrong token)", async () => {
  const mocks = makeMocks()
  const api = new DashboardApi(makeDeps(mocks))
  const res = await api.handle(req("GET", "/api/dashboard/overview", { token: "wrong-token" }))
  assert.equal(res.status, 401)
  assert.equal((res.body as any).code, "AUTH_INVALID")
})

test("route not found returns 404", async () => {
  const mocks = makeMocks()
  const api = new DashboardApi(makeDeps(mocks))
  const res = await api.handle(req("GET", "/api/dashboard/nonexistent"))
  assert.equal(res.status, 404)
  assert.equal((res.body as any).code, "ROUTE_NOT_FOUND")
})

// ── Runner ──────────────────────────────────────────────────

async function main() {
  console.log("DashboardApi Tests")
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
