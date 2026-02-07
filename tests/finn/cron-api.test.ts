// tests/finn/cron-api.test.ts — CronApi route handler tests (TASK-3.6)

import assert from "node:assert/strict"
import { CronApi } from "../../src/gateway/cron-api.js"
import type { CronApiDeps, ApiRequest } from "../../src/gateway/cron-api.js"

// ── Test harness ────────────────────────────────────────────

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Mock factories ──────────────────────────────────────────

const AUTH_TOKEN = "test-secret-token-42"

interface MockCall { method: string; args: unknown[] }

function makeMocks() {
  const calls: MockCall[] = []
  const jobs: Record<string, any> = {}

  const cronService = {
    async createJob(job: any) {
      const created = { id: "job-new", ...job, createdAt: Date.now(), updatedAt: Date.now() }
      jobs[created.id] = created
      calls.push({ method: "createJob", args: [job] })
      return created
    },
    async updateJob(id: string, updates: any) {
      calls.push({ method: "updateJob", args: [id, updates] })
      if (!jobs[id]) return false
      jobs[id] = { ...jobs[id], ...updates }
      return true
    },
    async deleteJob(id: string) {
      calls.push({ method: "deleteJob", args: [id] })
      if (!jobs[id]) return false
      delete jobs[id]
      return true
    },
    async triggerJob(id: string) {
      calls.push({ method: "triggerJob", args: [id] })
      return !!jobs[id]
    },
  }

  let killSwitchActive = false
  const killSwitch = {
    async activate() {
      killSwitchActive = true
      calls.push({ method: "ks:activate", args: [] })
      return ["job-1"]
    },
    async deactivate() {
      killSwitchActive = false
      calls.push({ method: "ks:deactivate", args: [] })
    },
    async isActive() { return killSwitchActive },
  }

  const registry = {
    getJobs() { return Object.values(jobs) },
    getJob(id: string) { return jobs[id] },
  }

  return { cronService, killSwitch, registry, jobs, calls }
}

function makeDeps(mocks: ReturnType<typeof makeMocks>): CronApiDeps {
  return {
    cronService: mocks.cronService,
    killSwitch: mocks.killSwitch,
    registry: mocks.registry,
    authToken: AUTH_TOKEN,
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
    // Default: include valid auth for convenience
    headers["authorization"] = `Bearer ${AUTH_TOKEN}`
  }
  return {
    method,
    path,
    headers,
    body: opts?.body,
    query: opts?.query,
  }
}

// ── Tests ───────────────────────────────────────────────────

test("POST /api/cron/jobs creates job (201)", async () => {
  const mocks = makeMocks()
  const api = new CronApi(makeDeps(mocks))
  const res = await api.handle(req("POST", "/api/cron/jobs", {
    body: {
      templateId: "tmpl-digest",
      name: "Daily Digest",
      schedule: { kind: "cron", expression: "0 9 * * *" },
    },
  }))
  assert.equal(res.status, 201)
  const body = res.body as any
  assert.equal(body.job.templateId, "tmpl-digest")
  assert.equal(body.job.name, "Daily Digest")
  assert.equal(mocks.calls.length, 1)
  assert.equal(mocks.calls[0].method, "createJob")
})

test("GET /api/cron/jobs lists all jobs (200)", async () => {
  const mocks = makeMocks()
  mocks.jobs["j1"] = { id: "j1", name: "Job 1" }
  mocks.jobs["j2"] = { id: "j2", name: "Job 2" }
  const api = new CronApi(makeDeps(mocks))
  const res = await api.handle(req("GET", "/api/cron/jobs"))
  assert.equal(res.status, 200)
  const body = res.body as any
  assert.equal(body.jobs.length, 2)
})

test("PATCH /api/cron/jobs/:id updates job (200)", async () => {
  const mocks = makeMocks()
  mocks.jobs["j1"] = { id: "j1", name: "Old Name", enabled: true }
  const api = new CronApi(makeDeps(mocks))
  const res = await api.handle(req("PATCH", "/api/cron/jobs/j1", {
    body: { enabled: false },
  }))
  assert.equal(res.status, 200)
  const body = res.body as any
  assert.equal(body.job.enabled, false)
})

test("PATCH /api/cron/jobs/:id returns 404 for unknown job", async () => {
  const mocks = makeMocks()
  const api = new CronApi(makeDeps(mocks))
  const res = await api.handle(req("PATCH", "/api/cron/jobs/nonexistent", {
    body: { enabled: false },
  }))
  assert.equal(res.status, 404)
  assert.equal((res.body as any).code, "JOB_NOT_FOUND")
})

test("DELETE /api/cron/jobs/:id deletes job (200)", async () => {
  const mocks = makeMocks()
  mocks.jobs["j1"] = { id: "j1", name: "Doomed" }
  const api = new CronApi(makeDeps(mocks))
  const res = await api.handle(req("DELETE", "/api/cron/jobs/j1"))
  assert.equal(res.status, 200)
  assert.equal((res.body as any).deleted, true)
  assert.equal(mocks.jobs["j1"], undefined)
})

test("POST /api/cron/jobs/:id/trigger triggers job (200)", async () => {
  const mocks = makeMocks()
  mocks.jobs["j1"] = { id: "j1", name: "Triggerable" }
  const api = new CronApi(makeDeps(mocks))
  const res = await api.handle(req("POST", "/api/cron/jobs/j1/trigger"))
  assert.equal(res.status, 200)
  assert.equal((res.body as any).triggered, true)
})

test("POST /api/cron/kill-switch activates (200)", async () => {
  const mocks = makeMocks()
  const api = new CronApi(makeDeps(mocks))
  const res = await api.handle(req("POST", "/api/cron/kill-switch", {
    body: { action: "activate" },
  }))
  assert.equal(res.status, 200)
  assert.equal((res.body as any).active, true)
  assert.deepEqual((res.body as any).stoppedJobs, ["job-1"])
})

test("Auth required: POST without token returns 401", async () => {
  const mocks = makeMocks()
  const api = new CronApi(makeDeps(mocks))
  const res = await api.handle(req("POST", "/api/cron/jobs", {
    token: null,
    body: { templateId: "t", name: "n", schedule: { kind: "cron", expression: "* * * * *" } },
  }))
  assert.equal(res.status, 401)
  assert.equal((res.body as any).code, "AUTH_REQUIRED")
})

test("Auth required: POST with wrong token returns 401", async () => {
  const mocks = makeMocks()
  const api = new CronApi(makeDeps(mocks))
  const res = await api.handle(req("POST", "/api/cron/jobs", {
    token: "wrong-token",
    body: { templateId: "t", name: "n", schedule: { kind: "cron", expression: "* * * * *" } },
  }))
  assert.equal(res.status, 401)
  assert.equal((res.body as any).code, "AUTH_INVALID")
})

test("Auth required: GET /api/cron/jobs without token returns 401", async () => {
  const mocks = makeMocks()
  mocks.jobs["j1"] = { id: "j1" }
  const api = new CronApi(makeDeps(mocks))
  const res = await api.handle(req("GET", "/api/cron/jobs", { token: null }))
  assert.equal(res.status, 401)
  assert.equal((res.body as any).code, "AUTH_REQUIRED")
})

test("Invalid body: POST with missing fields returns 400", async () => {
  const mocks = makeMocks()
  const api = new CronApi(makeDeps(mocks))

  // Missing templateId
  const r1 = await api.handle(req("POST", "/api/cron/jobs", { body: { name: "x" } }))
  assert.equal(r1.status, 400)
  assert.equal((r1.body as any).code, "VALIDATION_ERROR")

  // Missing name
  const r2 = await api.handle(req("POST", "/api/cron/jobs", { body: { templateId: "t" } }))
  assert.equal(r2.status, 400)

  // Missing schedule
  const r3 = await api.handle(req("POST", "/api/cron/jobs", {
    body: { templateId: "t", name: "n" },
  }))
  assert.equal(r3.status, 400)
})

test("PATCH /api/cron/jobs/:id strips non-mutable fields (C-1 mass-assignment fix)", async () => {
  const mocks = makeMocks()
  mocks.jobs["j1"] = { id: "j1", name: "Original", enabled: true, circuitBreaker: { state: "closed" } }
  const api = new CronApi(makeDeps(mocks))
  const res = await api.handle(req("PATCH", "/api/cron/jobs/j1", {
    body: {
      name: "Updated",
      enabled: false,
      circuitBreaker: { state: "open" },  // should be stripped
      currentRunUlid: "injected-ulid",    // should be stripped
      _schemaVersion: 999,                // should be stripped
    },
  }))
  assert.equal(res.status, 200)
  // Verify only mutable fields were forwarded to cronService
  const updateCall = mocks.calls.find(c => c.method === "updateJob")
  assert.ok(updateCall, "updateJob should have been called")
  const updates = updateCall.args[1] as Record<string, unknown>
  assert.equal(updates.name, "Updated")
  assert.equal(updates.enabled, false)
  assert.equal(updates.circuitBreaker, undefined, "circuitBreaker should be stripped")
  assert.equal(updates.currentRunUlid, undefined, "currentRunUlid should be stripped")
  assert.equal(updates._schemaVersion, undefined, "_schemaVersion should be stripped")
})

test("PATCH /api/cron/jobs/:id returns 400 when only non-mutable fields sent", async () => {
  const mocks = makeMocks()
  mocks.jobs["j1"] = { id: "j1", name: "Test" }
  const api = new CronApi(makeDeps(mocks))
  const res = await api.handle(req("PATCH", "/api/cron/jobs/j1", {
    body: { circuitBreaker: { state: "open" }, currentRunUlid: "injected" },
  }))
  assert.equal(res.status, 400)
  assert.equal((res.body as any).code, "VALIDATION_ERROR")
})

test("GET /api/cron/jobs/:id/logs returns 501 Not Implemented (H-2)", async () => {
  const mocks = makeMocks()
  mocks.jobs["j1"] = { id: "j1", name: "Has Logs" }
  const api = new CronApi(makeDeps(mocks))
  const res = await api.handle(req("GET", "/api/cron/jobs/j1/logs"))
  assert.equal(res.status, 501)
  assert.equal((res.body as any).code, "NOT_IMPLEMENTED")
  assert.equal((res.body as any).jobId, "j1")
})

test("GET /api/cron/jobs/:id/logs returns 404 for unknown job", async () => {
  const mocks = makeMocks()
  const api = new CronApi(makeDeps(mocks))
  const res = await api.handle(req("GET", "/api/cron/jobs/nonexistent/logs"))
  assert.equal(res.status, 404)
  assert.equal((res.body as any).code, "JOB_NOT_FOUND")
})

test("POST /api/cron/kill-switch with action=deactivate", async () => {
  const mocks = makeMocks()
  const api = new CronApi(makeDeps(mocks))
  const res = await api.handle(req("POST", "/api/cron/kill-switch", {
    body: { action: "deactivate" },
  }))
  assert.equal(res.status, 200)
  assert.equal((res.body as any).active, false)
  assert.ok(mocks.calls.some(c => c.method === "ks:deactivate"))
})

// ── Runner ──────────────────────────────────────────────────

async function main() {
  console.log("CronApi Tests")
  console.log("=============")
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
