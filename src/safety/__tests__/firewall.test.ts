// src/safety/__tests__/firewall.test.ts — Firewall Safety Tests (PRD Section 7)
// FW-01 through FW-09: validates all firewall enforcement claims.

import assert from "node:assert/strict"
import {
  GitHubFirewall,
  FirewallDeniedError,
  type FirewallAuditTrail,
  type FirewallRateLimiter,
  type FirewallDedupeIndex,
  type FirewallAlertService,
  type FirewallConfig,
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

function mockRateLimiter(allow = true): FirewallRateLimiter {
  return {
    tryConsume: () => allow,
    getRemainingTokens: () => ({ global: allow ? 499 : 0 }),
  }
}

function mockDedupe(hasDuplicate = false): FirewallDedupeIndex {
  return {
    isDuplicate: () => hasDuplicate,
    async recordPending() {},
    async record() {},
  }
}

function mockAlert(): FirewallAlertService {
  return { async fire() { return true } }
}

function makeTool(name: string, result = { ok: true }): ToolDefinition {
  return { name, execute: async () => result }
}

function makeFirewall(overrides?: Partial<{
  audit: ReturnType<typeof mockAudit>; rateLimiter: FirewallRateLimiter
  dedupe: FirewallDedupeIndex; config: FirewallConfig
}>) {
  const audit = overrides?.audit ?? mockAudit()
  return {
    audit,
    firewall: new GitHubFirewall({
      auditTrail: audit,
      rateLimiter: overrides?.rateLimiter ?? mockRateLimiter(),
      dedupeIndex: overrides?.dedupe ?? mockDedupe(),
      alertService: mockAlert(),
      config: overrides?.config ?? {},
    }),
  }
}

// ── Tests ───────────────────────────────────────────────────

async function main() {
  console.log("Firewall Safety Tests (FW-01 through FW-09)")
  console.log("=============================================")

  await test("FW-01: Admin tools always denied (step 1)", async () => {
    const { firewall } = makeFirewall()
    for (const name of ["merge_pull_request", "delete_branch"]) {
      const [tool] = firewall.wrapTools([makeTool(name)])
      await assert.rejects(() => tool.execute({}), (err: unknown) => {
        assert.ok(err instanceof FirewallDeniedError)
        assert.equal(err.step, 1)
        assert.equal(err.toolName, name)
        return true
      })
    }
  })

  await test("FW-02: Unknown tool denied (step 0)", async () => {
    const { firewall } = makeFirewall()
    const [tool] = firewall.wrapTools([makeTool("totally_unknown_tool")])
    await assert.rejects(() => tool.execute({}), (err: unknown) => {
      assert.ok(err instanceof FirewallDeniedError)
      assert.equal(err.step, 0)
      return true
    })
  })

  await test("FW-03: push_files to branch=main denied (step 2)", async () => {
    const { firewall } = makeFirewall()
    const [tool] = firewall.wrapTools([makeTool("push_files")])
    await assert.rejects(() => tool.execute({ branch: "main", owner: "o", repo: "r" }), (err: unknown) => {
      assert.ok(err instanceof FirewallDeniedError)
      assert.equal(err.step, 2)
      return true
    })
  })

  await test("FW-04: create_pull_request without draft=true denied (step 2)", async () => {
    const { firewall } = makeFirewall()
    const [tool] = firewall.wrapTools([makeTool("create_pull_request")])
    await assert.rejects(() => tool.execute({ owner: "o", repo: "r" }), (err: unknown) => {
      assert.ok(err instanceof FirewallDeniedError)
      assert.equal(err.step, 2)
      return true
    })
  })

  await test("FW-05: Denied attempts create audit records", async () => {
    const audit = mockAudit()
    const { firewall } = makeFirewall({ audit })
    const [tool] = firewall.wrapTools([makeTool("merge_pull_request")])
    await tool.execute({}).catch(() => {})
    const denied = audit.calls.filter((c) => c.method === "recordDenied")
    assert.ok(denied.length > 0, "recordDenied should have been called")
  })

  await test("FW-06: Rate limit exhaustion blocks tool (step 6)", async () => {
    const { firewall } = makeFirewall({ rateLimiter: mockRateLimiter(false) })
    // Use a read tool (no param constraints, no admin) to isolate rate limit step
    const [tool] = firewall.wrapTools([makeTool("get_issue")])
    await assert.rejects(() => tool.execute({}), (err: unknown) => {
      assert.ok(err instanceof FirewallDeniedError)
      assert.equal(err.step, 6)
      return true
    })
  })

  await test("FW-07: Deduplicated mutation returns early (no execute call)", async () => {
    const executeCalled = { count: 0 }
    const tool: ToolDefinition = {
      name: "create_issue",
      execute: async () => { executeCalled.count++; return { id: 1 } },
    }
    const { firewall } = makeFirewall({ dedupe: mockDedupe(true) })
    const [wrapped] = firewall.wrapTools([tool])
    const result = await wrapped.execute({ owner: "o", repo: "r", title: "t" }) as Record<string, unknown>
    assert.equal(executeCalled.count, 0, "original execute should NOT be called")
    assert.equal(result.deduplicated, true)
  })

  await test("FW-08: Template deniedTools blocks tool (step 4)", async () => {
    const { firewall } = makeFirewall({
      config: { templatePolicy: { deniedTools: ["add_issue_comment"] } },
    })
    const [tool] = firewall.wrapTools([makeTool("add_issue_comment")])
    await assert.rejects(() => tool.execute({}), (err: unknown) => {
      assert.ok(err instanceof FirewallDeniedError)
      assert.equal(err.step, 4)
      return true
    })
  })

  await test("FW-09: Template allowedTools filters tool (step 4)", async () => {
    const { firewall } = makeFirewall({
      config: { templatePolicy: { allowedTools: ["get_issue"] } },
    })
    // get_pull_request is a known read tool but NOT in allowedTools
    const [tool] = firewall.wrapTools([makeTool("get_pull_request")])
    await assert.rejects(() => tool.execute({}), (err: unknown) => {
      assert.ok(err instanceof FirewallDeniedError)
      assert.equal(err.step, 4)
      return true
    })
  })

  console.log("\nDone.")
}

main()
