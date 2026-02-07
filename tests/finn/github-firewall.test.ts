// tests/finn/github-firewall.test.ts — GitHub Mutation Firewall tests (SDD §4.2)

import assert from "node:assert/strict"
import { GitHubFirewall, FirewallDeniedError } from "../../src/safety/github-firewall.js"
import type { ToolDefinition, FirewallConfig } from "../../src/safety/github-firewall.js"
import type { FirewallAuditTrail, FirewallRateLimiter, FirewallDedupeIndex, FirewallAlertService } from "../../src/safety/github-firewall.js"
import { DedupeIndex } from "../../src/cron/idempotency.js"

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

function mockAuditTrail(): FirewallAuditTrail & { calls: string[] } {
  let seq = 0
  const calls: string[] = []
  return {
    calls,
    async recordIntent() { calls.push("intent"); return ++seq },
    async recordResult() { calls.push("result"); return ++seq },
    async recordDenied() { calls.push("denied"); return ++seq },
    async recordDryRun() { calls.push("dry_run"); return ++seq },
  }
}

function mockRateLimiter(allow = true): FirewallRateLimiter {
  return {
    tryConsume: () => allow,
    getRemainingTokens: () => ({ global: 42 }),
  }
}

function mockDedupeIndex(duplicate = false): FirewallDedupeIndex {
  return {
    isDuplicate: () => duplicate,
    async recordPending() {},
    async record() {},
  }
}

function mockAlertService(): FirewallAlertService & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async fire(_sev, trigger) { calls.push(trigger); return true },
  }
}

function makeTool(name: string, result: unknown = { ok: true }): ToolDefinition {
  return {
    name,
    description: `Mock ${name}`,
    execute: async () => result,
  }
}

function makeFirewall(overrides: {
  config?: Partial<FirewallConfig>
  rateLimiter?: FirewallRateLimiter
  dedupeIndex?: FirewallDedupeIndex
  auditTrail?: FirewallAuditTrail
  alertService?: FirewallAlertService
} = {}) {
  const audit = overrides.auditTrail ?? mockAuditTrail()
  const alert = overrides.alertService ?? mockAlertService()
  return {
    firewall: new GitHubFirewall({
      auditTrail: audit,
      rateLimiter: overrides.rateLimiter ?? mockRateLimiter(),
      dedupeIndex: overrides.dedupeIndex ?? mockDedupeIndex(),
      alertService: alert,
      config: { jobId: "test-job", runUlid: "test-run", templateId: "tpl-1", ...overrides.config },
    }),
    audit: audit as ReturnType<typeof mockAuditTrail>,
    alert: alert as ReturnType<typeof mockAlertService>,
  }
}

// ── Tests ───────────────────────────────────────────────────

async function main() {
  console.log("GitHub Firewall Tests")
  console.log("=====================")

  // 1. Admin tool → always denied
  await test("admin tool (merge_pull_request) is always denied", async () => {
    const { firewall } = makeFirewall()
    const tools = firewall.wrapTools([makeTool("merge_pull_request")])
    await assert.rejects(
      () => tools[0].execute({ owner: "o", repo: "r", pull_number: 1 }),
      (err: unknown) => {
        assert.ok(err instanceof FirewallDeniedError)
        assert.equal(err.step, 1)
        assert.ok(err.reason.includes("Admin"))
        return true
      },
    )
  })

  // 2. Unknown tool → denied
  await test("unknown tool is denied", async () => {
    const { firewall } = makeFirewall()
    const tools = firewall.wrapTools([makeTool("hack_the_planet")])
    await assert.rejects(
      () => tools[0].execute({}),
      (err: unknown) => {
        assert.ok(err instanceof FirewallDeniedError)
        assert.equal(err.step, 0)
        assert.ok(err.reason.includes("Unknown"))
        return true
      },
    )
  })

  // 3. Param constraint violation (push_files with branch "main")
  await test("param constraint violation denies push_files to main", async () => {
    const { firewall } = makeFirewall()
    const tools = firewall.wrapTools([makeTool("push_files")])
    await assert.rejects(
      () => tools[0].execute({ branch: "main", owner: "o", repo: "r" }),
      (err: unknown) => {
        assert.ok(err instanceof FirewallDeniedError)
        assert.equal(err.step, 2)
        assert.ok(err.reason.includes("branch"))
        return true
      },
    )
  })

  // 4. Dry-run interception for write tools
  await test("dry-run intercepts write tools without calling execute", async () => {
    let executeCalled = false
    const tool: ToolDefinition = {
      name: "add_issue_comment",
      execute: async () => { executeCalled = true; return {} },
    }
    const { firewall } = makeFirewall({ config: { dryRun: true } })
    const tools = firewall.wrapTools([tool])
    const result = await tools[0].execute({ owner: "o", repo: "r", issue_number: 1, body: "hi" }) as Record<string, unknown>
    assert.equal(result.dryRun, true)
    assert.equal(result.tool, "add_issue_comment")
    assert.equal(executeCalled, false)
  })

  // 5. Template policy denied tools → blocked
  await test("template policy denied tools are blocked", async () => {
    const { firewall } = makeFirewall({
      config: { templatePolicy: { deniedTools: ["create_issue"] } },
    })
    const tools = firewall.wrapTools([makeTool("create_issue")])
    await assert.rejects(
      () => tools[0].execute({ owner: "o", repo: "r", title: "x" }),
      (err: unknown) => {
        assert.ok(err instanceof FirewallDeniedError)
        assert.equal(err.step, 4)
        assert.ok(err.reason.includes("template policy"))
        return true
      },
    )
  })

  // 6. Template policy allowed tools → unblocked
  await test("template policy allowed tools pass through", async () => {
    const { firewall } = makeFirewall({
      config: { templatePolicy: { allowedTools: ["get_pull_request"] } },
    })
    const tools = firewall.wrapTools([makeTool("get_pull_request", { pr: 42 })])
    const result = await tools[0].execute({ owner: "o", repo: "r", pull_number: 1 })
    assert.deepEqual(result, { pr: 42 })
  })

  // 7. Rate limit exhaustion → denied
  await test("rate limit exhaustion denies tool", async () => {
    const { firewall } = makeFirewall({ rateLimiter: mockRateLimiter(false) })
    const tools = firewall.wrapTools([makeTool("get_issue")])
    await assert.rejects(
      () => tools[0].execute({ owner: "o", repo: "r", issue_number: 1 }),
      (err: unknown) => {
        assert.ok(err instanceof FirewallDeniedError)
        assert.equal(err.step, 6)
        assert.ok(err.reason.includes("Rate limit"))
        return true
      },
    )
  })

  // 8. Dedupe check — already-completed mutation returns deduplicated result
  await test("dedupe returns deduplicated result for completed mutation", async () => {
    const { firewall } = makeFirewall({ dedupeIndex: mockDedupeIndex(true) })
    const tools = firewall.wrapTools([makeTool("add_issue_comment", { id: 999 })])
    const result = await tools[0].execute({ owner: "o", repo: "r", issue_number: 1, body: "dup" }) as Record<string, unknown>
    assert.equal(result.deduplicated, true)
    assert.equal(result.tool, "add_issue_comment")
  })

  // 9. Successful write tool → audits intent + result
  await test("successful write tool audits intent and result", async () => {
    const audit = mockAuditTrail()
    const { firewall } = makeFirewall({ auditTrail: audit })
    const tools = firewall.wrapTools([makeTool("add_issue_comment", { id: 1 })])
    await tools[0].execute({ owner: "o", repo: "r", issue_number: 1, body: "hello" })
    assert.ok(audit.calls.includes("intent"), "should record intent")
    assert.ok(audit.calls.includes("result"), "should record result")
  })

  // 10. Successful read tool → passes through (no dedupe)
  await test("read tool passes through without dedupe", async () => {
    const dedupeIndex = mockDedupeIndex()
    let recordPendingCalled = false
    dedupeIndex.recordPending = async () => { recordPendingCalled = true }
    const { firewall } = makeFirewall({ dedupeIndex })
    const tools = firewall.wrapTools([makeTool("get_pull_request", { number: 1 })])
    const result = await tools[0].execute({ owner: "o", repo: "r", pull_number: 1 })
    assert.deepEqual(result, { number: 1 })
    assert.equal(recordPendingCalled, false, "dedupe recordPending should not be called for read tools")
  })

  // 11. Execute error → audit records error
  await test("execute error is audited and re-thrown", async () => {
    const audit = mockAuditTrail()
    const failTool: ToolDefinition = {
      name: "add_issue_comment",
      execute: async () => { throw new Error("GitHub 500") },
    }
    const { firewall } = makeFirewall({ auditTrail: audit })
    const tools = firewall.wrapTools([failTool])
    await assert.rejects(
      () => tools[0].execute({ owner: "o", repo: "r", issue_number: 1, body: "fail" }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal(err.message, "GitHub 500")
        return true
      },
    )
    assert.ok(audit.calls.includes("intent"), "should record intent before execute")
    assert.ok(audit.calls.includes("result"), "should record error result")
  })

  console.log("\nDone.")
}

main()
