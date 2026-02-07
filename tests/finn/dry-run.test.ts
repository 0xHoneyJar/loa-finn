// tests/finn/dry-run.test.ts — Dry-Run Mode E2E tests (TASK-3.8)

import assert from "node:assert/strict"
import { DryRunInterceptor, isWriteTool, assertZeroWrites } from "../../src/cron/dry-run.js"

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── isWriteTool classification ──────────────────────────────

test("isWriteTool: classifies read tools as false", () => {
  const readTools = [
    "get_pull_request", "get_file_contents", "list_commits",
    "get_pull_request_files", "get_pull_request_reviews",
    "get_pull_request_comments", "get_issue", "list_issues",
    "search_code", "search_issues",
  ]
  for (const tool of readTools) {
    assert.equal(isWriteTool(tool), false, `Expected ${tool} to be read-only`)
  }
})

test("isWriteTool: classifies write tools as true", () => {
  const writeTools = [
    "create_pull_request_review", "add_issue_comment",
    "create_issue", "update_issue", "create_or_update_file",
    "push_files", "create_branch", "create_pull_request",
  ]
  for (const tool of writeTools) {
    assert.equal(isWriteTool(tool), true, `Expected ${tool} to be a write tool`)
  }
})

test("isWriteTool: classifies admin tools as true", () => {
  const adminTools = ["merge_pull_request", "delete_branch", "update_pull_request_branch"]
  for (const tool of adminTools) {
    assert.equal(isWriteTool(tool), true, `Expected ${tool} (admin) to be classified as write`)
  }
})

test("isWriteTool: unknown tools return false", () => {
  assert.equal(isWriteTool("nonexistent_tool"), false)
})

// ── DryRunInterceptor ───────────────────────────────────────

test("intercept: read tools pass through (returns undefined)", () => {
  const interceptor = new DryRunInterceptor()
  const result = interceptor.intercept("get_pull_request", { owner: "o", repo: "r", pull_number: 1 })
  assert.equal(result, undefined, "Read tool should pass through")
  assert.equal(interceptor.count, 0, "No calls should be intercepted")
})

test("intercept: write tools return simulated DryRunResult", () => {
  const interceptor = new DryRunInterceptor()
  const params = { owner: "o", repo: "r", body: "LGTM" }
  const result = interceptor.intercept("add_issue_comment", params)
  assert.ok(result, "Write tool should be intercepted")
  assert.equal(result.dryRun, true)
  assert.equal(result.tool, "add_issue_comment")
  assert.deepEqual(result.params, params)
  assert.equal(typeof result.message, "string")
})

test("intercept: admin tools are also intercepted", () => {
  const interceptor = new DryRunInterceptor()
  const result = interceptor.intercept("merge_pull_request", { owner: "o", repo: "r", pull_number: 1 })
  assert.ok(result, "Admin tool should be intercepted")
  assert.equal(result.dryRun, true)
  assert.equal(result.tool, "merge_pull_request")
})

test("intercept: unknown tools pass through (returns undefined)", () => {
  const interceptor = new DryRunInterceptor()
  const result = interceptor.intercept("unknown_tool", {})
  assert.equal(result, undefined, "Unknown tool should pass through to firewall")
})

test("getInterceptedCalls: tracks all intercepted write calls", () => {
  const interceptor = new DryRunInterceptor({ now: () => 1700000000000 })
  interceptor.intercept("add_issue_comment", { body: "hi" })
  interceptor.intercept("get_pull_request", { pull_number: 1 })
  interceptor.intercept("create_issue", { title: "bug" })
  interceptor.intercept("merge_pull_request", { pull_number: 2 })

  const calls = interceptor.getInterceptedCalls()
  assert.equal(calls.length, 3, "Should have 3 intercepted calls (2 write + 1 admin)")
  assert.equal(calls[0].toolName, "add_issue_comment")
  assert.equal(calls[0].capability, "write")
  assert.equal(calls[1].toolName, "create_issue")
  assert.equal(calls[1].capability, "write")
  assert.equal(calls[2].toolName, "merge_pull_request")
  assert.equal(calls[2].capability, "admin")
  // Timestamp uses injected clock
  assert.equal(calls[0].timestamp, new Date(1700000000000).toISOString())
})

test("count: reflects number of intercepted calls", () => {
  const interceptor = new DryRunInterceptor()
  assert.equal(interceptor.count, 0)
  interceptor.intercept("add_issue_comment", {})
  assert.equal(interceptor.count, 1)
  interceptor.intercept("get_pull_request", {})
  assert.equal(interceptor.count, 1, "Read tool should not increment count")
  interceptor.intercept("update_issue", {})
  assert.equal(interceptor.count, 2)
})

// ── assertZeroWrites ────────────────────────────────────────

test("assertZeroWrites: passes when all write records have dryRun: true", () => {
  const records = [
    { action: "get_pull_request", dryRun: false, phase: "intent" },
    { action: "get_pull_request", dryRun: false, phase: "result" },
    { action: "add_issue_comment", dryRun: true, phase: "dry_run" },
    { action: "create_issue", dryRun: true, phase: "dry_run" },
  ]
  const result = assertZeroWrites(records)
  assert.equal(result.pass, true)
  assert.equal(result.violations.length, 0)
})

test("assertZeroWrites: fails when write tool has intent without dryRun", () => {
  const records = [
    { action: "add_issue_comment", dryRun: false, phase: "intent" },
    { action: "add_issue_comment", dryRun: false, phase: "result" },
  ]
  const result = assertZeroWrites(records)
  assert.equal(result.pass, false)
  assert.equal(result.violations.length, 2)
  assert.ok(result.violations[0].includes("add_issue_comment"))
})

test("assertZeroWrites: ignores read tools without dryRun flag", () => {
  const records = [
    { action: "get_pull_request", dryRun: false, phase: "intent" },
    { action: "list_commits", dryRun: false, phase: "result" },
  ]
  const result = assertZeroWrites(records)
  assert.equal(result.pass, true)
})

// ── Full pipeline dry-run simulation ────────────────────────

test("full pipeline: dry-run intercepts all writes, passes all reads", () => {
  const interceptor = new DryRunInterceptor()

  // Simulate a job pipeline: read PR, read files, then attempt write actions
  const pipeline: Array<{ tool: string; params: Record<string, unknown> }> = [
    { tool: "get_pull_request", params: { owner: "o", repo: "r", pull_number: 42 } },
    { tool: "get_pull_request_files", params: { owner: "o", repo: "r", pull_number: 42 } },
    { tool: "get_file_contents", params: { owner: "o", repo: "r", path: "README.md" } },
    { tool: "create_pull_request_review", params: { owner: "o", repo: "r", pull_number: 42, event: "COMMENT", body: "Looks good" } },
    { tool: "add_issue_comment", params: { owner: "o", repo: "r", issue_number: 42, body: "Reviewed" } },
  ]

  const auditRecords: Array<{ action: string; dryRun: boolean; phase: string }> = []
  const readResults: unknown[] = []

  for (const step of pipeline) {
    const intercepted = interceptor.intercept(step.tool, step.params)
    if (intercepted) {
      // Write was intercepted — record as dry_run in audit
      auditRecords.push({ action: step.tool, dryRun: true, phase: "dry_run" })
    } else {
      // Read passed through — simulate normal execution + audit
      readResults.push({ tool: step.tool, data: "mock-response" })
      auditRecords.push({ action: step.tool, dryRun: false, phase: "intent" })
      auditRecords.push({ action: step.tool, dryRun: false, phase: "result" })
    }
  }

  // Verify: 3 reads passed through, 2 writes intercepted
  assert.equal(readResults.length, 3, "3 read tools should pass through")
  assert.equal(interceptor.count, 2, "2 write tools should be intercepted")

  // Verify audit trail has zero actual writes
  const auditResult = assertZeroWrites(auditRecords)
  assert.equal(auditResult.pass, true, "assertZeroWrites should pass")
  assert.equal(auditResult.violations.length, 0)

  // Verify all audit records for write tools have dryRun: true
  const writeAuditRecords = auditRecords.filter((r) => isWriteTool(r.action))
  for (const record of writeAuditRecords) {
    assert.equal(record.dryRun, true, `Audit record for ${record.action} should have dryRun: true`)
  }
})

test("full pipeline: interceptedCalls preserves order and params", () => {
  const interceptor = new DryRunInterceptor()
  const writes = [
    { tool: "add_issue_comment", params: { body: "first" } },
    { tool: "create_issue", params: { title: "second" } },
    { tool: "update_issue", params: { state: "closed" } },
  ]

  for (const w of writes) {
    interceptor.intercept(w.tool, w.params)
  }

  const calls = interceptor.getInterceptedCalls()
  assert.equal(calls.length, 3)
  assert.equal(calls[0].toolName, "add_issue_comment")
  assert.deepEqual(calls[0].params, { body: "first" })
  assert.equal(calls[1].toolName, "create_issue")
  assert.deepEqual(calls[1].params, { title: "second" })
  assert.equal(calls[2].toolName, "update_issue")
  assert.deepEqual(calls[2].params, { state: "closed" })
})

// ── Runner ──────────────────────────────────────────────────

async function main() {
  console.log("Dry-Run Mode Tests (TASK-3.8)")
  console.log("=============================")
  let passed = 0, failed = 0
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
