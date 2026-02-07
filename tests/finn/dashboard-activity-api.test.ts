// tests/finn/dashboard-activity-api.test.ts — GitHubActivityApi tests (TASK-6.3)

import assert from "node:assert/strict"
import { GitHubActivityApi } from "../../src/gateway/dashboard-activity-api.js"
import type { ActivityApiDeps, ApiRequest, AuditTrailRecord } from "../../src/gateway/dashboard-activity-api.js"

// ── Test harness ────────────────────────────────────────────

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Mock factories ──────────────────────────────────────────

const AUTH_TOKEN = "test-activity-token-99"

function makeRecords(...items: Partial<AuditTrailRecord>[]): AuditTrailRecord[] {
  return items.map((item, i) => ({
    id: item.id ?? `rec-${i}`,
    timestamp: item.timestamp ?? Date.now() - i * 1000,
    action: item.action ?? "unknown",
    phase: item.phase ?? "result",
    jobId: item.jobId,
    templateId: item.templateId,
    metadata: item.metadata,
  }))
}

function makeDeps(records: AuditTrailRecord[]): ActivityApiDeps {
  return {
    auditTrail: { getRecords: () => records },
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

// ── Tests ───────────────────────────────────────────────────

test("returns GitHub mutation activities", async () => {
  const records = makeRecords(
    { action: "add_issue_comment" },
    { action: "create_pull_request" },
    { action: "push_files" },
  )
  const api = new GitHubActivityApi(makeDeps(records))
  const res = await api.handle(req("GET", "/api/dashboard/github-activity"))
  assert.equal(res.status, 200)
  const body = res.body as any
  assert.equal(body.activities.length, 3)
  assert.equal(body.total, 3)
})

test("filters non-GitHub actions", async () => {
  const records = makeRecords(
    { action: "add_issue_comment" },
    { action: "schedule_job" },
    { action: "run_workflow" },
    { action: "create_branch" },
  )
  const api = new GitHubActivityApi(makeDeps(records))
  const res = await api.handle(req("GET", "/api/dashboard/github-activity"))
  const body = res.body as any
  assert.equal(body.activities.length, 2)
  assert.equal(body.activities[0].action, "add_issue_comment")
  assert.equal(body.activities[1].action, "create_branch")
})

test("groups by type correctly", async () => {
  const records = makeRecords(
    { action: "add_issue_comment" },
    { action: "create_pull_request_review" },
    { action: "create_pull_request" },
    { action: "update_issue" },
    { action: "push_files" },
  )
  const api = new GitHubActivityApi(makeDeps(records))
  const res = await api.handle(req("GET", "/api/dashboard/github-activity"))
  const body = res.body as any
  assert.equal(body.summary.comments, 1)
  assert.equal(body.summary.reviews, 1)
  assert.equal(body.summary.pullRequests, 1)
  assert.equal(body.summary.issueUpdates, 1)
  assert.equal(body.summary.other, 1)
})

test("respects limit param (default 100)", async () => {
  const manyRecords = makeRecords(
    ...Array.from({ length: 150 }, (_, i) => ({ action: "push_files", id: `r-${i}` })),
  )
  const api = new GitHubActivityApi(makeDeps(manyRecords))
  const res = await api.handle(req("GET", "/api/dashboard/github-activity"))
  const body = res.body as any
  assert.equal(body.activities.length, 100)
})

test("max limit capped at 200", async () => {
  const manyRecords = makeRecords(
    ...Array.from({ length: 250 }, (_, i) => ({ action: "push_files", id: `r-${i}` })),
  )
  const api = new GitHubActivityApi(makeDeps(manyRecords))
  const res = await api.handle(req("GET", "/api/dashboard/github-activity", {
    query: { limit: "999" },
  }))
  const body = res.body as any
  assert.equal(body.activities.length, 200)
})

test("summary counts correct", async () => {
  const records = makeRecords(
    { action: "add_issue_comment" },
    { action: "add_issue_comment" },
    { action: "create_pull_request_review" },
    { action: "create_pull_request_review" },
    { action: "create_pull_request_review" },
    { action: "create_pull_request" },
    { action: "create_pull_request" },
    { action: "update_issue" },
    { action: "create_or_update_file" },
    { action: "merge_pull_request" },
    { action: "create_branch" },
  )
  const api = new GitHubActivityApi(makeDeps(records))
  const res = await api.handle(req("GET", "/api/dashboard/github-activity"))
  const body = res.body as any
  assert.equal(body.summary.comments, 2)
  assert.equal(body.summary.reviews, 3)
  assert.equal(body.summary.pullRequests, 3) // create_pull_request + merge_pull_request + create_pull_request (no "review")
  assert.equal(body.summary.issueUpdates, 1)
  assert.equal(body.summary.other, 2) // create_or_update_file + create_branch
  assert.equal(body.total, 11)
})

test("activities include timestamp and action", async () => {
  const ts = Date.now()
  const records = makeRecords({ action: "create_branch", timestamp: ts })
  const api = new GitHubActivityApi(makeDeps(records))
  const res = await api.handle(req("GET", "/api/dashboard/github-activity"))
  const body = res.body as any
  assert.equal(body.activities[0].timestamp, ts)
  assert.equal(body.activities[0].action, "create_branch")
})

test("target extraction from metadata", async () => {
  const records = makeRecords(
    { action: "add_issue_comment", metadata: { pull_number: 42 } },
    { action: "update_issue", metadata: { issue_number: 7 } },
    { action: "push_files" },
  )
  const api = new GitHubActivityApi(makeDeps(records))
  const res = await api.handle(req("GET", "/api/dashboard/github-activity"))
  const body = res.body as any
  assert.deepEqual(body.activities[0].target, { type: "pr", number: 42 })
  assert.deepEqual(body.activities[1].target, { type: "issue", number: 7 })
  assert.equal(body.activities[2].target, undefined)
})

test("auth required (401 without token)", async () => {
  const api = new GitHubActivityApi(makeDeps([]))
  const res = await api.handle(req("GET", "/api/dashboard/github-activity", { token: null }))
  assert.equal(res.status, 401)
  assert.equal((res.body as any).code, "AUTH_REQUIRED")
})

test("empty audit trail returns empty response", async () => {
  const api = new GitHubActivityApi(makeDeps([]))
  const res = await api.handle(req("GET", "/api/dashboard/github-activity"))
  assert.equal(res.status, 200)
  const body = res.body as any
  assert.equal(body.activities.length, 0)
  assert.equal(body.total, 0)
  assert.equal(body.summary.comments, 0)
  assert.equal(body.summary.reviews, 0)
  assert.equal(body.summary.pullRequests, 0)
  assert.equal(body.summary.issueUpdates, 0)
  assert.equal(body.summary.other, 0)
})

// ── Runner ──────────────────────────────────────────────────

async function main() {
  console.log("GitHubActivityApi Tests")
  console.log("=======================")
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
