// src/safety/__tests__/dry-run.test.ts — Dry-Run Mode Safety Tests (PRD Section 7)
// DR-01 through DR-04: validates dry-run interception claims.

import assert from "node:assert/strict"
import {
  GitHubFirewall,
  type FirewallAuditTrail,
  type FirewallRateLimiter,
  type FirewallDedupeIndex,
  type FirewallAlertService,
  type ToolDefinition,
} from "../../safety/github-firewall.js"

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

// ── Mock factories ──────────────────────────────────────────

function mockAudit(): FirewallAuditTrail & { calls: { method: string; args: unknown[] }[] } {
  let seq = 0
  const calls: { method: string; args: unknown[] }[] = []
  return {
    calls,
    async recordIntent(data) { calls.push({ method: "recordIntent", args: [data] }); return ++seq },
    async recordResult(intentSeq, data) { calls.push({ method: "recordResult", args: [intentSeq, data] }); return ++seq },
    async recordDenied(data) { calls.push({ method: "recordDenied", args: [data] }); return ++seq },
    async recordDryRun(data) { calls.push({ method: "recordDryRun", args: [data] }); return ++seq },
  }
}

function mockRateLimiter(): FirewallRateLimiter {
  return {
    tryConsume: () => true,
    getRemainingTokens: () => ({ global: 499 }),
  }
}

function mockDedupe(): FirewallDedupeIndex {
  return {
    isDuplicate: () => false,
    async recordPending() {},
    async record() {},
  }
}

function mockAlert(): FirewallAlertService {
  return { async fire() { return true } }
}

function makeDryRunFirewall(audit: ReturnType<typeof mockAudit>) {
  return new GitHubFirewall({
    auditTrail: audit,
    rateLimiter: mockRateLimiter(),
    dedupeIndex: mockDedupe(),
    alertService: mockAlert(),
    config: { dryRun: true },
  })
}

// ── Tests ───────────────────────────────────────────────────

async function main() {
  console.log("Dry-Run Mode Safety Tests (DR-01 through DR-04)")
  console.log("=================================================")

  await test("DR-01: Write tool in dry-run returns acknowledgment, execute NOT called", async () => {
    const executeCalled = { count: 0 }
    const tool: ToolDefinition = {
      name: "create_issue",
      execute: async () => { executeCalled.count++; return { id: 1 } },
    }
    const audit = mockAudit()
    const firewall = makeDryRunFirewall(audit)
    const [wrapped] = firewall.wrapTools([tool])

    const result = await wrapped.execute({ owner: "o", repo: "r", title: "test" }) as Record<string, unknown>
    assert.equal(result.dryRun, true, "result should indicate dry-run")
    assert.equal(result.tool, "create_issue")
    assert.ok(result.message, "should include a message")
    assert.equal(executeCalled.count, 0, "original execute must NOT be called")
  })

  await test("DR-02: recordDryRun called for write tool in dry-run", async () => {
    const tool: ToolDefinition = {
      name: "create_issue",
      execute: async () => ({ id: 1 }),
    }
    const audit = mockAudit()
    const firewall = makeDryRunFirewall(audit)
    const [wrapped] = firewall.wrapTools([tool])

    await wrapped.execute({ owner: "o", repo: "r", title: "test" })
    const dryRunCalls = audit.calls.filter((c) => c.method === "recordDryRun")
    assert.ok(dryRunCalls.length > 0, "recordDryRun should have been called")
    // Ensure no recordIntent was called (dry-run short-circuits before intent)
    const intentCalls = audit.calls.filter((c) => c.method === "recordIntent")
    assert.equal(intentCalls.length, 0, "recordIntent should NOT be called in dry-run")
  })

  await test("DR-03: Read tool in dry-run passes through normally", async () => {
    const executeCalled = { count: 0 }
    const expectedResult = { number: 42, title: "test issue" }
    const tool: ToolDefinition = {
      name: "get_issue",
      execute: async () => { executeCalled.count++; return expectedResult },
    }
    const audit = mockAudit()
    const firewall = makeDryRunFirewall(audit)
    const [wrapped] = firewall.wrapTools([tool])

    const result = await wrapped.execute({ owner: "o", repo: "r", issue_number: 42 })
    assert.deepEqual(result, expectedResult, "read tool should return actual result")
    assert.equal(executeCalled.count, 1, "execute SHOULD be called for read tools")

    // Verify audit used recordIntent + recordResult (not recordDryRun)
    const dryRunCalls = audit.calls.filter((c) => c.method === "recordDryRun")
    assert.equal(dryRunCalls.length, 0, "recordDryRun should NOT be called for read tools")
  })

  await test("DR-04: assertZeroWrites — zero executions for write tools", async () => {
    const writeExecuteCount = { count: 0 }
    const readExecuteCount = { count: 0 }
    const tools: ToolDefinition[] = [
      { name: "create_issue", execute: async () => { writeExecuteCount.count++; return {} } },
      { name: "add_issue_comment", execute: async () => { writeExecuteCount.count++; return {} } },
      { name: "get_issue", execute: async () => { readExecuteCount.count++; return { id: 1 } } },
    ]
    const audit = mockAudit()
    const firewall = makeDryRunFirewall(audit)
    const wrapped = firewall.wrapTools(tools)

    // Call all tools
    await wrapped[0].execute({ owner: "o", repo: "r", title: "t" })
    await wrapped[1].execute({ owner: "o", repo: "r", issue_number: 1, body: "c" })
    await wrapped[2].execute({ owner: "o", repo: "r", issue_number: 1 })

    // Assert zero writes executed
    assert.equal(writeExecuteCount.count, 0, "write tools must have zero executions in dry-run")
    assert.equal(readExecuteCount.count, 1, "read tools should still execute")
  })

  console.log("\nDone.")
}

main()
