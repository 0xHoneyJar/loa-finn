// tests/finn/dashboard-audit-api.test.ts — AuditApi route handler tests (TASK-6.2)

import assert from "node:assert/strict"
import { AuditApi } from "../../src/gateway/dashboard-audit-api.js"
import type { AuditApiDeps, AuditRecord, ApiRequest } from "../../src/gateway/dashboard-audit-api.js"

// ── Test harness ─────────────────────────────────────────────

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Mock factories ───────────────────────────────────────────

const AUTH_TOKEN = "test-audit-token-99"

function sampleRecords(): AuditRecord[] {
  return [
    { id: "a1", timestamp: 1000, jobId: "j1", templateId: "t1", action: "execute", phase: "start" },
    { id: "a2", timestamp: 2000, jobId: "j1", templateId: "t1", action: "execute", phase: "end" },
    { id: "a3", timestamp: 3000, jobId: "j2", templateId: "t2", action: "schedule", phase: "start" },
    { id: "a4", timestamp: 4000, jobId: "j2", templateId: "t2", action: "schedule", phase: "end", data: { secretKey: "super-secret" } },
    { id: "a5", timestamp: 5000, jobId: "j3", templateId: "t1", action: "execute", phase: "start" },
  ]
}

function makeDeps(opts?: {
  records?: AuditRecord[]
  chainValid?: boolean
  brokenAt?: number
}): AuditApiDeps {
  const records = opts?.records ?? sampleRecords()

  return {
    auditTrail: {
      getRecords(queryOpts) {
        let result = [...records]
        if (queryOpts?.since !== undefined) result = result.filter((r) => r.timestamp >= queryOpts.since!)
        if (queryOpts?.until !== undefined) result = result.filter((r) => r.timestamp <= queryOpts.until!)
        return result
      },
      getRecordCount() {
        return records.length
      },
      async verifyChain() {
        return { valid: opts?.chainValid ?? true, brokenAt: opts?.brokenAt }
      },
    },
    redactor: {
      redact<T>(obj: T): T {
        // Simple mock: replace any string value in fields matching "secret" (case-insensitive)
        return JSON.parse(
          JSON.stringify(obj, (_key, value) => {
            if (typeof _key === "string" && /secret/i.test(_key) && typeof value === "string") {
              return "[REDACTED]"
            }
            return value
          }),
        )
      },
    },
    authToken: AUTH_TOKEN,
  }
}

function req(method: string, path: string, opts?: {
  token?: string | null
  query?: Record<string, string>
}): ApiRequest {
  const headers: Record<string, string> = {}
  if (opts?.token !== null && opts?.token !== undefined) {
    headers["authorization"] = `Bearer ${opts.token}`
  } else if (opts?.token === undefined) {
    headers["authorization"] = `Bearer ${AUTH_TOKEN}`
  }
  return { method, path, headers, query: opts?.query }
}

// ── Tests ────────────────────────────────────────────────────

test("GET /audit returns paginated records with default limit", async () => {
  const api = new AuditApi(makeDeps())
  const res = await api.handle(req("GET", "/api/dashboard/audit"))
  assert.equal(res.status, 200)
  const body = res.body as any
  assert.equal(body.records.length, 5)
  assert.equal(body.pagination.limit, 50)
  assert.equal(body.pagination.offset, 0)
  assert.equal(body.pagination.total, 5)
})

test("GET /audit respects limit and offset params", async () => {
  const api = new AuditApi(makeDeps())
  const res = await api.handle(req("GET", "/api/dashboard/audit", {
    query: { limit: "2", offset: "1" },
  }))
  assert.equal(res.status, 200)
  const body = res.body as any
  assert.equal(body.records.length, 2)
  assert.equal(body.records[0].id, "a2")
  assert.equal(body.records[1].id, "a3")
  assert.equal(body.pagination.limit, 2)
  assert.equal(body.pagination.offset, 1)
  assert.equal(body.pagination.total, 5)
})

test("GET /audit filters by job", async () => {
  const api = new AuditApi(makeDeps())
  const res = await api.handle(req("GET", "/api/dashboard/audit", {
    query: { job: "j2" },
  }))
  const body = res.body as any
  assert.equal(body.records.length, 2)
  assert.ok(body.records.every((r: any) => r.jobId === "j2"))
  assert.equal(body.pagination.total, 2)
})

test("GET /audit filters by template", async () => {
  const api = new AuditApi(makeDeps())
  const res = await api.handle(req("GET", "/api/dashboard/audit", {
    query: { template: "t2" },
  }))
  const body = res.body as any
  assert.equal(body.records.length, 2)
  assert.ok(body.records.every((r: any) => r.templateId === "t2"))
})

test("GET /audit filters by action", async () => {
  const api = new AuditApi(makeDeps())
  const res = await api.handle(req("GET", "/api/dashboard/audit", {
    query: { action: "schedule" },
  }))
  const body = res.body as any
  assert.equal(body.records.length, 2)
  assert.ok(body.records.every((r: any) => r.action === "schedule"))
})

test("GET /audit filters by from/to timestamps", async () => {
  const api = new AuditApi(makeDeps())
  const res = await api.handle(req("GET", "/api/dashboard/audit", {
    query: { from: "2000", to: "4000" },
  }))
  const body = res.body as any
  assert.equal(body.records.length, 3)
  assert.ok(body.records.every((r: any) => r.timestamp >= 2000 && r.timestamp <= 4000))
})

test("GET /audit redacts sensitive fields in records", async () => {
  const api = new AuditApi(makeDeps())
  const res = await api.handle(req("GET", "/api/dashboard/audit", {
    query: { job: "j2", action: "schedule", offset: "1" },
  }))
  const body = res.body as any
  // Record a4 has data.secretKey which should be redacted
  assert.equal(body.records.length, 1)
  assert.equal(body.records[0].id, "a4")
  assert.equal(body.records[0].data.secretKey, "[REDACTED]")
})

test("GET /audit/verify returns chain verification result", async () => {
  const api = new AuditApi(makeDeps({ chainValid: true }))
  const res = await api.handle(req("GET", "/api/dashboard/audit/verify"))
  assert.equal(res.status, 200)
  const body = res.body as any
  assert.equal(body.valid, true)
  assert.equal(body.brokenAt, undefined)
  assert.equal(body.totalRecords, 5)
})

test("GET /audit/verify returns brokenAt when chain invalid", async () => {
  const api = new AuditApi(makeDeps({ chainValid: false, brokenAt: 3 }))
  const res = await api.handle(req("GET", "/api/dashboard/audit/verify"))
  assert.equal(res.status, 200)
  const body = res.body as any
  assert.equal(body.valid, false)
  assert.equal(body.brokenAt, 3)
  assert.equal(body.totalRecords, 5)
})

test("auth required: returns 401 without token", async () => {
  const api = new AuditApi(makeDeps())
  const res = await api.handle(req("GET", "/api/dashboard/audit", { token: null }))
  assert.equal(res.status, 401)
  assert.equal((res.body as any).code, "AUTH_REQUIRED")
})

test("route not found returns 404", async () => {
  const api = new AuditApi(makeDeps())
  const res = await api.handle(req("GET", "/api/dashboard/nonexistent"))
  assert.equal(res.status, 404)
  assert.equal((res.body as any).code, "ROUTE_NOT_FOUND")
})

// ── Runner ───────────────────────────────────────────────────

async function main() {
  console.log("AuditApi Tests")
  console.log("==============")
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
