// tests/finn/dashboard-integration.test.ts — Dashboard Integration Tests (TASK-6.9)
//
// Composes multiple Sprint 6 components together to verify their interactions:
// auth, rate limiting, redaction, CSRF, APIs, and the dashboard UI.

import assert from "node:assert/strict"
import { DashboardApi } from "../../src/gateway/dashboard-routes.js"
import type { DashboardDeps, ApiRequest } from "../../src/gateway/dashboard-routes.js"
import { AuditApi } from "../../src/gateway/dashboard-audit-api.js"
import type { AuditApiDeps, AuditRecord } from "../../src/gateway/dashboard-audit-api.js"
import { GitHubActivityApi } from "../../src/gateway/dashboard-activity-api.js"
import type { ActivityApiDeps, AuditTrailRecord } from "../../src/gateway/dashboard-activity-api.js"
import { Dashboard } from "../../src/gateway/dashboard.js"
import { DashboardAuth } from "../../src/gateway/dashboard-auth.js"
import { DashboardRateLimiter } from "../../src/gateway/dashboard-rate-limit.js"
import { ResponseRedactor } from "../../src/gateway/redaction-middleware.js"
import { CsrfProtection } from "../../src/gateway/csrf.js"

// ── Test harness ────────────────────────────────────────────

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Shared constants ────────────────────────────────────────

const AUTH_TOKEN = "integration-test-token-42"

// ── Integration mock factory ────────────────────────────────

function makeIntegrationMocks() {
  const now = Date.now()

  const jobs: DashboardDeps["registry"] extends { getJobs(): infer R } ? R : never = [
    { id: "pr-review", enabled: true, status: "running" },
    { id: "stale-cleanup", enabled: true, status: "idle" },
    { id: "issue-triage", enabled: false, status: "idle", circuitBreaker: { state: "open", failures: 3, lastFailureAt: "2026-02-07T08:00:00Z" } },
  ]

  const auditRecords: AuditRecord[] = [
    { id: "a1", timestamp: now - 1000, action: "job:execute", phase: "result", jobId: "pr-review", data: { success: true } },
    { id: "a2", timestamp: now - 2000, action: "add_issue_comment", phase: "call", jobId: "pr-review", templateId: "t1", data: { pull_number: 42 } },
    { id: "a3", timestamp: now - 3000, action: "create_pull_request_review", phase: "call", jobId: "pr-review", templateId: "t1" },
    { id: "a4", timestamp: now - 4000, action: "update_issue", phase: "call", jobId: "issue-triage", templateId: "t2" },
    { id: "a5", timestamp: now - 5000, action: "job:execute", phase: "result", jobId: "stale-cleanup", data: { success: false } },
    { id: "a6", timestamp: now - 6000, action: "config:update", phase: "call", data: { token: "ghp_secret1234567890abcdefghijklmnopqrstuvwxyz" } },
    { id: "a7", timestamp: now - 7000, action: "github:mutation", phase: "call", data: { itemsProcessed: 5 } },
    { id: "a8", timestamp: now - 8000, action: "github:read", phase: "call", data: { itemsProcessed: 10 } },
  ]

  const registry = { getJobs: () => jobs }

  const killSwitch = { isActive: async () => false }

  // Unified audit trail that satisfies all API dep shapes
  const auditTrail = {
    getRecords(opts?: { since?: number; until?: number; limit?: number; offset?: number }) {
      let result = [...auditRecords]
      if (opts?.since != null) result = result.filter((r) => r.timestamp >= opts.since!)
      if (opts?.until != null) result = result.filter((r) => r.timestamp <= opts.until!)
      return result
    },
    getRecordCount() { return auditRecords.length },
    async verifyChain() { return { valid: true } },
  }

  const redactor = new ResponseRedactor()
  const rateLimiter = new DashboardRateLimiter({ maxRequests: 3, windowMs: 60_000 })
  const csrf = new CsrfProtection()
  const auth = new DashboardAuth({ adminToken: AUTH_TOKEN, bindAddress: "0.0.0.0" })

  return { jobs, auditRecords, registry, killSwitch, auditTrail, redactor, rateLimiter, csrf, auth, now }
}

function authHeaders(token?: string): Record<string, string> {
  return { authorization: `Bearer ${token ?? AUTH_TOKEN}` }
}

function noAuthHeaders(): Record<string, string> {
  return {}
}

// ── 1. Overview API returns correct aggregate data ──────────

test("overview API returns correct aggregate data", async () => {
  const m = makeIntegrationMocks()
  const api = new DashboardApi({
    registry: m.registry,
    killSwitch: m.killSwitch,
    auditTrail: m.auditTrail,
    authToken: AUTH_TOKEN,
  })

  const res = await api.handle({ method: "GET", path: "/api/dashboard/overview", headers: authHeaders() })
  assert.equal(res.status, 200)

  const body = res.body as any
  // Status should be degraded (one circuit breaker is open)
  assert.equal(body.status, "degraded")
  assert.equal(body.killSwitch, false)
  // Job counts: 3 total, 2 enabled, 1 running, 1 circuit open
  assert.equal(body.jobs.total, 3)
  assert.equal(body.jobs.enabled, 2)
  assert.equal(body.jobs.running, 1)
  assert.equal(body.jobs.circuitOpen, 1)
  // Audit integrity
  assert.equal(body.auditIntegrity.chainValid, true)
  assert.equal(body.auditIntegrity.totalRecords, 8)
})

// ── 2. Audit API pagination and filtering ───────────────────

test("audit API pagination and filtering work correctly", async () => {
  const m = makeIntegrationMocks()
  const auditApi = new AuditApi({ auditTrail: m.auditTrail, redactor: m.redactor, authToken: AUTH_TOKEN })

  // Pagination: limit=2, offset=0
  const page1 = await auditApi.handle({ method: "GET", path: "/api/dashboard/audit", headers: authHeaders(), query: { limit: "2", offset: "0" } })
  assert.equal(page1.status, 200)
  const p1Body = page1.body as any
  assert.equal(p1Body.records.length, 2)
  assert.equal(p1Body.pagination.limit, 2)
  assert.equal(p1Body.pagination.offset, 0)
  assert.equal(p1Body.pagination.total, 8)

  // Pagination: limit=2, offset=2
  const page2 = await auditApi.handle({ method: "GET", path: "/api/dashboard/audit", headers: authHeaders(), query: { limit: "2", offset: "2" } })
  const p2Body = page2.body as any
  assert.equal(p2Body.records.length, 2)
  assert.equal(p2Body.pagination.offset, 2)

  // Filter by job
  const jobFiltered = await auditApi.handle({ method: "GET", path: "/api/dashboard/audit", headers: authHeaders(), query: { job: "pr-review" } })
  const jfBody = jobFiltered.body as any
  assert.equal(jfBody.pagination.total, 3)
  for (const r of jfBody.records) assert.equal(r.jobId, "pr-review")

  // Filter by action
  const actionFiltered = await auditApi.handle({ method: "GET", path: "/api/dashboard/audit", headers: authHeaders(), query: { action: "update_issue" } })
  const afBody = actionFiltered.body as any
  assert.equal(afBody.pagination.total, 1)
  assert.equal(afBody.records[0].action, "update_issue")

  // Filter by template
  const templateFiltered = await auditApi.handle({ method: "GET", path: "/api/dashboard/audit", headers: authHeaders(), query: { template: "t2" } })
  const tfBody = templateFiltered.body as any
  assert.equal(tfBody.pagination.total, 1)
  assert.equal(tfBody.records[0].templateId, "t2")
})

// ── 3. Auth enforcement across all APIs ─────────────────────

test("auth enforcement: unauthenticated rejected across all APIs", async () => {
  const m = makeIntegrationMocks()

  const dashboardApi = new DashboardApi({ registry: m.registry, killSwitch: m.killSwitch, auditTrail: m.auditTrail, authToken: AUTH_TOKEN })
  const auditApi = new AuditApi({ auditTrail: m.auditTrail, redactor: m.redactor, authToken: AUTH_TOKEN })
  const activityApi = new GitHubActivityApi({ auditTrail: m.auditTrail, authToken: AUTH_TOKEN })
  const dashboard = new Dashboard({ overviewApi: dashboardApi, authToken: AUTH_TOKEN })

  const apis = [
    { name: "DashboardApi", fn: () => dashboardApi.handle({ method: "GET", path: "/api/dashboard/overview", headers: noAuthHeaders() }) },
    { name: "AuditApi", fn: () => auditApi.handle({ method: "GET", path: "/api/dashboard/audit", headers: noAuthHeaders() }) },
    { name: "GitHubActivityApi", fn: () => activityApi.handle({ method: "GET", path: "/api/dashboard/github-activity", headers: noAuthHeaders() }) },
    { name: "Dashboard GET", fn: () => dashboard.handle({ method: "GET", path: "/dashboard", headers: noAuthHeaders() }) },
    { name: "Dashboard POST", fn: () => dashboard.handle({ method: "POST", path: "/dashboard/kill-switch", headers: noAuthHeaders() }) },
  ]

  for (const api of apis) {
    const res = await api.fn()
    assert.equal(res.status, 401, `${api.name} should return 401 without token`)
    assert.equal((res.body as any).code, "AUTH_REQUIRED", `${api.name} should return AUTH_REQUIRED code`)
  }
})

// ── 4. Secret redaction in audit responses ──────────────────

test("secret redaction verified in audit API responses", async () => {
  const m = makeIntegrationMocks()
  const auditApi = new AuditApi({ auditTrail: m.auditTrail, redactor: m.redactor, authToken: AUTH_TOKEN })

  const res = await auditApi.handle({ method: "GET", path: "/api/dashboard/audit", headers: authHeaders() })
  assert.equal(res.status, 200)

  const body = res.body as any
  // Record a6 has data.token with a ghp_ pattern — should be redacted
  const sensitiveRecord = body.records.find((r: any) => r.id === "a6")
  assert.ok(sensitiveRecord, "sensitive record a6 should exist")
  // The field name "token" matches the sensitive field pattern, so entire value is replaced
  assert.equal(sensitiveRecord.data.token, "[REDACTED]")
})

// ── 5. CSRF protection on dashboard forms ───────────────────

test("CSRF protection on dashboard forms", () => {
  const csrf = new CsrfProtection()

  // Safe methods pass without tokens
  const getResult = csrf.validate({ method: "GET", headers: {} })
  assert.equal(getResult.valid, true)

  // POST without cookie fails
  const postNoCookie = csrf.validate({ method: "POST", headers: {}, body: {} })
  assert.equal(postNoCookie.valid, false)
  assert.ok(postNoCookie.error?.includes("cookie"))

  // POST with cookie but no form token fails
  const { token, cookieHeader } = csrf.generateToken()
  const postNoForm = csrf.validate({ method: "POST", headers: {}, cookies: { _csrf: token }, body: {} })
  assert.equal(postNoForm.valid, false)
  assert.ok(postNoForm.error?.includes("token missing"))

  // POST with matching cookie + form token passes
  const postValid = csrf.validate({ method: "POST", headers: {}, cookies: { _csrf: token }, body: { _csrf: token } })
  assert.equal(postValid.valid, true)

  // POST with mismatched tokens fails
  const { token: otherToken } = csrf.generateToken()
  const postMismatch = csrf.validate({ method: "POST", headers: {}, cookies: { _csrf: token }, body: { _csrf: otherToken } })
  assert.equal(postMismatch.valid, false)
  assert.ok(postMismatch.error?.includes("mismatch"))

  // Bearer-authenticated requests bypass CSRF
  const postBearer = csrf.validate({ method: "POST", headers: { authorization: "Bearer any-token" }, body: {} })
  assert.equal(postBearer.valid, true)
})

// ── 6. Rate limiting across requests ────────────────────────

test("rate limiting headers and 429 enforcement", () => {
  const limiter = new DashboardRateLimiter({ maxRequests: 3, windowMs: 60_000 })
  const clientReq = { remoteAddr: "10.0.0.1" }

  // First 3 requests should be allowed, with decreasing remaining count
  for (let i = 1; i <= 3; i++) {
    const result = limiter.check(clientReq)
    assert.equal(result.allowed, true, `request ${i} should be allowed`)
    assert.ok("X-RateLimit-Limit" in result.headers)
    assert.equal(result.headers["X-RateLimit-Limit"], "3")
    assert.equal(result.headers["X-RateLimit-Remaining"], String(3 - i))
  }

  // 4th request should be rate limited
  const blocked = limiter.check(clientReq)
  assert.equal(blocked.allowed, false)
  assert.ok("Retry-After" in blocked.headers)
  assert.ok(blocked.retryAfterSeconds !== undefined && blocked.retryAfterSeconds > 0)

  // Different IP should not be affected
  const otherResult = limiter.check({ remoteAddr: "10.0.0.2" })
  assert.equal(otherResult.allowed, true)
})

// ── 7. Dashboard UI renders with overview data ──────────────

test("dashboard UI renders with overview data", async () => {
  const m = makeIntegrationMocks()
  const overviewApi = new DashboardApi({ registry: m.registry, killSwitch: m.killSwitch, auditTrail: m.auditTrail, authToken: AUTH_TOKEN })
  const dashboard = new Dashboard({ overviewApi, authToken: AUTH_TOKEN })

  const res = await dashboard.handle({ method: "GET", path: "/dashboard", headers: authHeaders() })
  assert.equal(res.status, 200)

  const html = res.body as string
  assert.ok(typeof html === "string", "body should be an HTML string")
  // Status badge present
  assert.ok(html.includes("status-badge"), "should contain status badge class")
  assert.ok(html.includes("DEGRADED"), "should show DEGRADED status")
  // Job counts
  assert.ok(html.includes(">3</div>"), "should show total jobs count of 3")
  assert.ok(html.includes(">1</div>"), "should show running count of 1")
  // Kill switch form
  assert.ok(html.includes("/dashboard/kill-switch"), "should contain kill switch form action")
  assert.ok(html.includes("Activate Kill Switch"), "should show activate button when kill switch off")
  // Audit integrity
  assert.ok(html.includes("Chain valid"), "should show chain valid status")
})

// ── 8. Activity feed filters GitHub actions ─────────────────

test("activity feed filters GitHub actions correctly", async () => {
  const m = makeIntegrationMocks()
  const activityApi = new GitHubActivityApi({ auditTrail: m.auditTrail, authToken: AUTH_TOKEN })

  const res = await activityApi.handle({ method: "GET", path: "/api/dashboard/github-activity", headers: authHeaders() })
  assert.equal(res.status, 200)

  const body = res.body as any
  // Only add_issue_comment, create_pull_request_review, update_issue are GitHub actions
  // (job:execute, config:update, github:mutation, github:read are NOT in GITHUB_ACTIONS set)
  assert.equal(body.total, 3)
  const actions = body.activities.map((a: any) => a.action).sort()
  assert.deepEqual(actions, ["add_issue_comment", "create_pull_request_review", "update_issue"])

  // Verify summary counts
  assert.equal(body.summary.comments, 1)   // add_issue_comment
  assert.equal(body.summary.reviews, 1)    // create_pull_request_review
  assert.equal(body.summary.issueUpdates, 1) // update_issue
})

// ── 9. Full pipeline: auth -> rate-limit -> API -> redact ───

test("full pipeline: auth -> rate-limit -> API -> redact", async () => {
  const m = makeIntegrationMocks()
  const auditApi = new AuditApi({ auditTrail: m.auditTrail, redactor: m.redactor, authToken: AUTH_TOKEN })
  const limiter = new DashboardRateLimiter({ maxRequests: 2, windowMs: 60_000 })
  const auth = new DashboardAuth({ adminToken: AUTH_TOKEN, bindAddress: "0.0.0.0" })

  // Simulate the full pipeline for a request
  async function pipeline(headers: Record<string, string>): Promise<{ status: number; body: unknown; rateLimitHeaders?: Record<string, string> }> {
    // Step 1: Auth check
    const authResult = auth.checkAccess({ headers, remoteAddr: "10.0.0.1" }, "viewer")
    if (authResult) return { status: authResult.status, body: authResult.body }

    // Step 2: Rate limit check
    const rlResult = limiter.check({ remoteAddr: "10.0.0.1" })
    if (!rlResult.allowed) return { status: 429, body: { error: "Too Many Requests" }, rateLimitHeaders: rlResult.headers }

    // Step 3: API call (includes its own auth check + redaction)
    const apiRes = await auditApi.handle({ method: "GET", path: "/api/dashboard/audit", headers, query: { limit: "3" } })
    return { status: apiRes.status, body: apiRes.body, rateLimitHeaders: rlResult.headers }
  }

  // Unauthenticated request is rejected at auth step
  const noAuth = await pipeline(noAuthHeaders())
  assert.equal(noAuth.status, 401)

  // First authenticated request succeeds with rate limit headers
  const req1 = await pipeline(authHeaders())
  assert.equal(req1.status, 200)
  assert.ok(req1.rateLimitHeaders?.["X-RateLimit-Remaining"])

  // Second request also succeeds
  const req2 = await pipeline(authHeaders())
  assert.equal(req2.status, 200)

  // Third request is rate limited
  const req3 = await pipeline(authHeaders())
  assert.equal(req3.status, 429)

  // Verify that successful responses have redacted data
  const records = (req1.body as any).records
  const sensitiveRecord = records.find((r: any) => r.id === "a6")
  if (sensitiveRecord) {
    assert.equal(sensitiveRecord.data.token, "[REDACTED]")
  }
})

// ── Runner ──────────────────────────────────────────────────

async function main() {
  console.log("Dashboard Integration Tests")
  console.log("===========================")
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
