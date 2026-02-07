// tests/finn/runner.test.ts — JobRunner tests (SDD §5.2, Flatline IMP-004)

import assert from "node:assert/strict"
import { JobRunner } from "../../src/cron/runner.js"
import type {
  Template,
  TemplateItem,
  JobContext,
  SessionFactory,
  SessionResult,
  AuditContextManager,
  SessionOptions,
} from "../../src/cron/runner.js"
import { CRON_BASH_POLICIES, CRON_NETWORK_POLICY } from "../../src/cron/sandbox-policies.js"
import type { CronJob } from "../../src/cron/types.js"

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

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "Test Job",
    templateId: "tpl-1",
    schedule: { kind: "every", expression: "1h" },
    status: "armed",
    concurrencyPolicy: "skip",
    enabled: true,
    oneShot: false,
    config: {},
    circuitBreaker: { state: "closed", failures: 0, successes: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeTemplate(items: TemplateItem[] = [], actionPolicy?: Template["actionPolicy"]): Template {
  return {
    id: "tpl-1",
    resolveItems: async () => items,
    actionPolicy,
  }
}

function makeContext(): JobContext & { loaded: boolean; saved: boolean; updates: Array<{ key: string; hash: string }> } {
  const seen = new Map<string, string>()
  const obj = {
    loaded: false,
    saved: false,
    updates: [] as Array<{ key: string; hash: string }>,
    hasChanged(key: string, hash: string) {
      return seen.get(key) !== hash
    },
    update(key: string, hash: string) {
      seen.set(key, hash)
      obj.updates.push({ key, hash })
    },
    async save() { obj.saved = true },
    async load() { obj.loaded = true },
  }
  return obj
}

function makeSessionFactory(result: Partial<SessionResult> = {}): SessionFactory & { calls: SessionOptions[] } {
  const calls: SessionOptions[] = []
  return {
    calls,
    async createSession(opts: SessionOptions) {
      calls.push(opts)
      return { toolCalls: 1, success: true, ...result }
    },
  }
}

function makeAuditContext(): AuditContextManager & { setCtx: unknown; cleared: boolean } {
  const obj = {
    setCtx: null as unknown,
    cleared: false,
    setRunContext(ctx: { jobId: string; runUlid: string; templateId: string }) {
      obj.setCtx = ctx
    },
    clearRunContext() {
      obj.cleared = true
    },
  }
  return obj
}

function makeItems(count: number): TemplateItem[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `item-${i}`,
    hash: `hash-${i}`,
    data: { index: i },
  }))
}

// ── Tests ───────────────────────────────────────────────────

async function main() {
  console.log("JobRunner Tests")
  console.log("================")

  // 1. Template resolution via injected resolver
  await test("1. resolves template via injected resolver", async () => {
    const template = makeTemplate([{ key: "pr-1", hash: "abc", data: {} }])
    const ctx = makeContext()
    const sf = makeSessionFactory()
    const audit = makeAuditContext()

    const runner = new JobRunner({
      resolveTemplate: async (id) => id === "tpl-1" ? template : null,
      createContext: () => ctx,
      sessionFactory: sf,
      auditContext: audit,
    })

    const record = await runner.run(makeJob(), "run-001")
    assert.equal(record.status, "success")
    assert.equal(record.itemsProcessed, 1)
    assert.equal(sf.calls.length, 1)
    assert.equal(sf.calls[0].templateId, "tpl-1")
  })

  // 2. Template not found returns failure
  await test("2. template not found returns failure", async () => {
    const runner = new JobRunner({
      resolveTemplate: async () => null,
      createContext: () => makeContext(),
      sessionFactory: makeSessionFactory(),
      auditContext: makeAuditContext(),
    })

    const record = await runner.run(makeJob(), "run-002")
    assert.equal(record.status, "failure")
    assert.ok(record.error?.includes("not found"))
  })

  // 3. Context filtering — hasChanged false skips item
  await test("3. context filtering skips unchanged items", async () => {
    const ctx = makeContext()
    // Pre-seed context so item appears unchanged
    ctx.update("pr-1", "same-hash")

    const template = makeTemplate([{ key: "pr-1", hash: "same-hash", data: {} }])
    const sf = makeSessionFactory()

    const runner = new JobRunner({
      resolveTemplate: async () => template,
      createContext: () => ctx,
      sessionFactory: sf,
      auditContext: makeAuditContext(),
    })

    const record = await runner.run(makeJob(), "run-003")
    assert.equal(record.status, "success")
    assert.equal(record.itemsProcessed, 0)
    assert.equal(sf.calls.length, 0, "no sessions should be created for unchanged items")
  })

  // 4. Items limited to maxItems (default 50)
  await test("4. items limited to maxItems", async () => {
    const template = makeTemplate(makeItems(60))
    const sf = makeSessionFactory()

    const runner = new JobRunner({
      resolveTemplate: async () => template,
      createContext: () => makeContext(),
      sessionFactory: sf,
      auditContext: makeAuditContext(),
    })

    const record = await runner.run(makeJob(), "run-004")
    assert.equal(record.status, "success")
    assert.equal(record.itemsProcessed, 50, "should process at most 50 items (default)")
    assert.equal(sf.calls.length, 50)
  })

  // 5. Custom maxItems config
  await test("5. custom maxItems config limits items", async () => {
    const template = makeTemplate(makeItems(10))
    const sf = makeSessionFactory()

    const runner = new JobRunner({
      resolveTemplate: async () => template,
      createContext: () => makeContext(),
      sessionFactory: sf,
      auditContext: makeAuditContext(),
    })

    const record = await runner.run(makeJob({ config: { maxItems: 3 } }), "run-005")
    assert.equal(record.itemsProcessed, 3)
    assert.equal(sf.calls.length, 3)
  })

  // 6. Tool calls limited to maxToolCalls — abort when exceeded
  await test("6. tool call limit aborts run", async () => {
    const template = makeTemplate(makeItems(5))
    // Each session uses 50 tool calls
    const sf = makeSessionFactory({ toolCalls: 50 })

    const runner = new JobRunner({
      resolveTemplate: async () => template,
      createContext: () => makeContext(),
      sessionFactory: sf,
      auditContext: makeAuditContext(),
    })

    // Default maxToolCalls=200, 50 per session -> 4th session hits 200
    const record = await runner.run(makeJob(), "run-006")
    assert.equal(record.status, "aborted")
    assert.ok(record.error?.includes("Tool call limit"))
    // Should process 4 items (4*50=200 hits limit after 4th)
    assert.equal(record.itemsProcessed, 4)
    assert.equal(record.toolCalls, 200)
  })

  // 7. Runtime limited to maxRuntimeMinutes — abort on timeout
  await test("7. runtime limit causes timeout", async () => {
    let clock = 0
    const template = makeTemplate(makeItems(5))

    // Session factory advances clock by 10 minutes per call
    const sf: SessionFactory = {
      async createSession() {
        clock += 10 * 60_000
        return { toolCalls: 1, success: true }
      },
    }

    const runner = new JobRunner({
      resolveTemplate: async () => template,
      createContext: () => makeContext(),
      sessionFactory: sf,
      auditContext: makeAuditContext(),
      now: () => clock,
    })

    // maxRuntimeMinutes=30 -> timeout after 30 min
    const record = await runner.run(makeJob(), "run-007")
    assert.equal(record.status, "timeout")
    assert.ok(record.error?.includes("Runtime limit"))
  })

  // 8. Audit context set before execution, cleared after
  await test("8. audit context lifecycle", async () => {
    const template = makeTemplate([{ key: "pr-1", hash: "abc", data: {} }])
    const audit = makeAuditContext()

    const runner = new JobRunner({
      resolveTemplate: async () => template,
      createContext: () => makeContext(),
      sessionFactory: makeSessionFactory(),
      auditContext: audit,
    })

    await runner.run(makeJob(), "run-008")
    assert.deepEqual(audit.setCtx, { jobId: "job-1", runUlid: "run-008", templateId: "tpl-1" })
    assert.equal(audit.cleared, true)
  })

  // 9. Audit context cleared even on failure
  await test("9. audit context cleared on failure", async () => {
    const audit = makeAuditContext()

    const runner = new JobRunner({
      resolveTemplate: async () => { throw new Error("boom") },
      createContext: () => makeContext(),
      sessionFactory: makeSessionFactory(),
      auditContext: audit,
    })

    const record = await runner.run(makeJob(), "run-009")
    assert.equal(record.status, "failure")
    assert.equal(audit.cleared, true)
  })

  // 10. Sandbox configuration uses CRON_BASH_POLICIES and CRON_NETWORK_POLICY
  await test("10. sandbox policies passed to session factory", async () => {
    const template = makeTemplate([{ key: "pr-1", hash: "abc", data: {} }])
    const sf = makeSessionFactory()

    const runner = new JobRunner({
      resolveTemplate: async () => template,
      createContext: () => makeContext(),
      sessionFactory: sf,
      auditContext: makeAuditContext(),
    })

    await runner.run(makeJob(), "run-010")
    assert.equal(sf.calls.length, 1)
    assert.deepEqual(sf.calls[0].bashPolicies, CRON_BASH_POLICIES)
    assert.deepEqual(sf.calls[0].networkPolicy, CRON_NETWORK_POLICY)
  })

  // 11. Run record tracks itemsProcessed and toolCalls accurately
  await test("11. run record counters are accurate", async () => {
    const template = makeTemplate(makeItems(3))
    const sf = makeSessionFactory({ toolCalls: 7 })

    const runner = new JobRunner({
      resolveTemplate: async () => template,
      createContext: () => makeContext(),
      sessionFactory: sf,
      auditContext: makeAuditContext(),
    })

    const record = await runner.run(makeJob(), "run-011")
    assert.equal(record.itemsProcessed, 3)
    assert.equal(record.toolCalls, 21) // 3 items * 7 tool calls each
    assert.equal(record.status, "success")
    assert.equal(typeof record.durationMs, "number")
    assert.ok(record.completedAt)
  })

  // 12. Session failure records error in run record
  await test("12. session failure records error", async () => {
    const template = makeTemplate([{ key: "pr-1", hash: "abc", data: {} }])
    const sf = makeSessionFactory({ success: false, error: "GitHub API 500" })

    const runner = new JobRunner({
      resolveTemplate: async () => template,
      createContext: () => makeContext(),
      sessionFactory: sf,
      auditContext: makeAuditContext(),
    })

    const record = await runner.run(makeJob(), "run-012")
    assert.equal(record.status, "failure")
    assert.equal(record.error, "GitHub API 500")
    assert.equal(record.itemsProcessed, 1)
  })

  // 13. Empty items list returns success with 0 items
  await test("13. empty items returns success with 0 processed", async () => {
    const template = makeTemplate([])
    const sf = makeSessionFactory()

    const runner = new JobRunner({
      resolveTemplate: async () => template,
      createContext: () => makeContext(),
      sessionFactory: sf,
      auditContext: makeAuditContext(),
    })

    const record = await runner.run(makeJob(), "run-013")
    assert.equal(record.status, "success")
    assert.equal(record.itemsProcessed, 0)
    assert.equal(record.toolCalls, 0)
    assert.equal(sf.calls.length, 0)
  })

  console.log("\nDone.")
}

main()
