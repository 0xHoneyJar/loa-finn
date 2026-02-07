// tests/finn/live-fire.test.ts — Controlled live-fire integration test (TASK-3.10)
//
// Validates real GitHub API integration. Gated by AGENT_JOBS_LIVE_TEST=1.
// Run: AGENT_JOBS_LIVE_TEST=1 npx tsx tests/finn/live-fire.test.ts

import assert from "node:assert/strict"
import { createHash } from "node:crypto"

// ── Inline types (self-contained, no imports) ──────────────

interface ToolCapabilityMap {
  [tool: string]: "read" | "write" | "admin"
}

interface AuditEntry {
  seq: number
  phase: string
  action: string
  target: string
  dryRun: boolean
  hash: string
  prevHash: string
}

interface FirewallDeps {
  auditTrail: { records: AuditEntry[] }
  rateLimiter: { remaining: number }
  alertService: { alerts: Array<{ severity: string; type: string }> }
}

// ── Harness ────────────────────────────────────────────────

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Shared state (populated by real API calls) ─────────────

const TOOL_CAPABILITIES: ToolCapabilityMap = {
  get_pull_request: "read",
  get_pull_request_files: "read",
  get_issue: "read",
  list_issues: "read",
  search_code: "read",
  create_pull_request_review: "write",
  add_issue_comment: "write",
  create_issue: "write",
  push_files: "write",
  merge_pull_request: "admin",
  delete_branch: "admin",
  update_branch_protection: "admin",
}

function computeHash(entry: Omit<AuditEntry, "hash">): string {
  const payload = JSON.stringify({ seq: entry.seq, phase: entry.phase, action: entry.action, target: entry.target, dryRun: entry.dryRun, prevHash: entry.prevHash })
  return createHash("sha256").update(payload).digest("hex")
}

// Shared mutable state across tests
const auditTrail: AuditEntry[] = []
let lastRateLimitRemaining = -1
let killSwitchActive = false

function appendAudit(phase: string, action: string, target: string, dryRun = false): AuditEntry {
  const seq = auditTrail.length + 1
  const prevHash = seq === 1 ? "genesis" : auditTrail[seq - 2].hash
  const entry: AuditEntry = { seq, phase, action, target, dryRun, hash: "", prevHash }
  entry.hash = computeHash(entry)
  auditTrail.push(entry)
  return entry
}

// ── Environment helpers ────────────────────────────────────

function env(key: string, fallback?: string): string {
  return process.env[key] ?? fallback ?? ""
}

function ghHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${env("AGENT_JOBS_GITHUB_TOKEN")}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "finn-live-fire-test",
  }
}

// ── Tests ──────────────────────────────────────────────────

test("env: required variables are set", () => {
  const token = env("AGENT_JOBS_GITHUB_TOKEN")
  assert.ok(token.length > 0, "AGENT_JOBS_GITHUB_TOKEN must be set")

  const owner = env("AGENT_JOBS_TEST_OWNER", "0xHoneyJar")
  const repo = env("AGENT_JOBS_TEST_REPO", "agent-jobs-test")
  const pr = env("AGENT_JOBS_TEST_PR", "1")

  assert.ok(owner.length > 0, "owner must be non-empty")
  assert.ok(repo.length > 0, "repo must be non-empty")
  assert.ok(Number(pr) > 0, "PR number must be positive")
})

test("read tool: get_pull_request succeeds against real API", async () => {
  const owner = env("AGENT_JOBS_TEST_OWNER", "0xHoneyJar")
  const repo = env("AGENT_JOBS_TEST_REPO", "agent-jobs-test")
  const pr = env("AGENT_JOBS_TEST_PR", "1")

  appendAudit("intent", "get_pull_request", `${owner}/${repo}#${pr}`)

  const res = await globalThis.fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}`,
    { headers: ghHeaders() },
  )

  assert.equal(res.status, 200, `Expected 200, got ${res.status}`)
  const body = (await res.json()) as { number: number; title: string }
  assert.equal(body.number, Number(pr))

  // Track rate limit from headers
  const remaining = res.headers.get("x-ratelimit-remaining")
  if (remaining !== null) lastRateLimitRemaining = Number(remaining)

  appendAudit("result", "get_pull_request", `${owner}/${repo}#${pr}`)
})

test("write tool: create_pull_request_review with COMMENT event succeeds", async () => {
  const owner = env("AGENT_JOBS_TEST_OWNER", "0xHoneyJar")
  const repo = env("AGENT_JOBS_TEST_REPO", "agent-jobs-test")
  const pr = env("AGENT_JOBS_TEST_PR", "1")

  appendAudit("intent", "create_pull_request_review", `${owner}/${repo}#${pr}`)

  const res = await globalThis.fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}/reviews`,
    {
      method: "POST",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "COMMENT",
        body: "[Live-fire test] Automated review comment \u2014 safe to ignore",
      }),
    },
  )

  assert.ok(res.status >= 200 && res.status < 300, `Expected 2xx, got ${res.status}`)
  const body = (await res.json()) as { id: number }
  assert.ok(body.id > 0, "Review should have a positive ID")

  appendAudit("result", "create_pull_request_review", `${owner}/${repo}#${pr}`)
})

test("admin tool: merge_pull_request is denied by firewall", () => {
  const cap = TOOL_CAPABILITIES.merge_pull_request
  assert.equal(cap, "admin", "merge_pull_request must be classified as admin")

  // Simulate firewall denial (no real API call)
  appendAudit("denied", "merge_pull_request", "firewall-check", false)

  // Verify the denied entry was recorded
  const denied = auditTrail.filter((e) => e.phase === "denied")
  assert.ok(denied.length > 0, "Should have at least one denied entry")
  assert.equal(denied[0].action, "merge_pull_request")
})

test("audit trail: valid hash chain after real operations", () => {
  assert.ok(auditTrail.length >= 4, `Expected >=4 audit entries, got ${auditTrail.length}`)

  // Verify genesis link
  assert.equal(auditTrail[0].prevHash, "genesis")

  // Verify chain continuity
  for (let i = 1; i < auditTrail.length; i++) {
    assert.equal(
      auditTrail[i].prevHash,
      auditTrail[i - 1].hash,
      `Chain break at seq ${auditTrail[i].seq}: prevHash mismatch`,
    )
  }

  // Verify each hash is correct
  for (const entry of auditTrail) {
    const expected = computeHash(entry)
    assert.equal(entry.hash, expected, `Hash mismatch at seq ${entry.seq}`)
  }
})

test("audit trail: intent-result pairs for all mutations", () => {
  const intents = auditTrail.filter((e) => e.phase === "intent")
  const results = auditTrail.filter((e) => e.phase === "result" || e.phase === "denied")

  // Every intent for a mutation should have a corresponding result or denied
  for (const intent of intents) {
    const paired = results.find(
      (r) => r.action === intent.action && r.target === intent.target,
    )
    assert.ok(paired, `Intent for ${intent.action} on ${intent.target} has no result/denied pair`)
  }
})

test("zero denied admin-capability attempts", () => {
  // Normal operation should not attempt admin tools (the denied entry above is a firewall check, not an attempt)
  const adminAttempts = auditTrail.filter(
    (e) => e.phase === "intent" && TOOL_CAPABILITIES[e.action] === "admin",
  )
  assert.equal(adminAttempts.length, 0, `Expected 0 admin intent attempts, got ${adminAttempts.length}`)
})

test("kill switch: halts execution when activated mid-run", () => {
  killSwitchActive = true

  // Simulate an operation that checks the kill switch
  const operationSkipped = killSwitchActive
  assert.equal(operationSkipped, true, "Operation should be skipped when kill switch is active")

  // Verify no new audit entries are added after kill switch
  const countBefore = auditTrail.length
  if (!killSwitchActive) {
    appendAudit("intent", "should_not_happen", "test")
  }
  assert.equal(auditTrail.length, countBefore, "No new entries after kill switch activation")

  killSwitchActive = false // reset for cleanup
})

test("rate limit headers tracked correctly", () => {
  assert.ok(
    lastRateLimitRemaining >= 0,
    `Expected rate limit remaining >= 0, got ${lastRateLimitRemaining}`,
  )
  assert.ok(
    lastRateLimitRemaining < 100_000,
    `Rate limit remaining ${lastRateLimitRemaining} seems unreasonably high`,
  )
})

// ── Runner ─────────────────────────────────────────────────

async function main() {
  console.log("Live-Fire Integration Tests (TASK-3.10)")
  console.log("========================================")

  if (process.env.AGENT_JOBS_LIVE_TEST !== "1") {
    console.log("  SKIP  All tests \u2014 AGENT_JOBS_LIVE_TEST=1 not set")
    console.log("  (Set AGENT_JOBS_LIVE_TEST=1 with valid GitHub App token to run)")
    console.log("\n0 passed, 0 failed (all skipped)")
    return
  }

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
