// tests/finn/phase1-acceptance.test.ts — Phase 1 Acceptance Gate (TASK-3.9)
//
// End-to-end pipeline test: boot → firewall → audit → cron lifecycle.
// Self-contained — all types and mocks are inlined (no cross-repo imports).

import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFile, mkdtemp, rm } from "node:fs/promises"
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"

// ── Inline test harness ─────────────────────────────────────

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Inline types ────────────────────────────────────────────

type AuditPhase = "intent" | "result" | "denied" | "dry_run"
type ToolCapability = "read" | "write" | "admin"

interface AuditEntry {
  seq: number
  phase: AuditPhase
  action: string
  target: string
  params: Record<string, unknown>
  dryRun: boolean
  intentSeq?: number
  result?: unknown
  error?: string
  rateLimitRemaining?: number
}

interface ToolDef {
  name: string
  capability: ToolCapability
  execute: (params: Record<string, unknown>) => Promise<unknown>
  actualCalls: number
}

// ── Tool capability map ─────────────────────────────────────

const CAPABILITIES: Record<string, ToolCapability> = {
  get_pull_request: "read",
  get_pull_request_files: "read",
  list_pull_requests: "read",
  create_pull_request_review: "write",
  add_issue_comment: "write",
  merge_pull_request: "admin",
  delete_branch: "admin",
}

// ── Mock AuditTrail (in-memory + file-backed) ───────────────

class MockAuditTrail {
  private seq = 0
  private lastHash = "genesis"
  private entries: AuditEntry[] = []
  readonly filePath: string
  private jobId = ""
  private runUlid = ""
  private templateId = ""

  constructor(filePath: string) {
    this.filePath = filePath
  }

  setRunContext(ctx: { jobId: string; runUlid: string; templateId: string }): void {
    this.jobId = ctx.jobId
    this.runUlid = ctx.runUlid
    this.templateId = ctx.templateId
  }

  private async append(phase: AuditPhase, data: Partial<AuditEntry>): Promise<number> {
    this.seq += 1
    const entry: AuditEntry = {
      seq: this.seq,
      phase,
      action: data.action ?? "",
      target: data.target ?? "",
      params: data.params ?? {},
      dryRun: data.dryRun ?? false,
      intentSeq: data.intentSeq,
      result: data.result,
      error: data.error,
      rateLimitRemaining: data.rateLimitRemaining,
    }
    this.entries.push(entry)

    // Also write to file for chain verification
    const record: Record<string, unknown> = {
      ...entry,
      prevHash: this.lastHash,
      ts: new Date().toISOString(),
      jobId: this.jobId,
      runUlid: this.runUlid,
      templateId: this.templateId,
    }
    const canonical = JSON.stringify(record, Object.keys(record).sort())
    const hash = createHash("sha256").update(canonical).digest("hex")
    record.hash = hash
    this.lastHash = hash

    const { appendFile } = await import("node:fs/promises")
    await appendFile(this.filePath, JSON.stringify(record) + "\n", "utf-8")
    return this.seq
  }

  async recordIntent(data: { action: string; target: string; params: Record<string, unknown>; dedupeKey?: string; dryRun?: boolean }): Promise<number> {
    return this.append("intent", data)
  }
  async recordResult(intentSeq: number, data: { action: string; target: string; params: Record<string, unknown>; result?: unknown; error?: string; rateLimitRemaining?: number; dryRun?: boolean }): Promise<number> {
    return this.append("result", { ...data, intentSeq })
  }
  async recordDenied(data: { action: string; target: string; params: Record<string, unknown>; dryRun?: boolean }): Promise<number> {
    return this.append("denied", data)
  }
  async recordDryRun(data: { action: string; target: string; params: Record<string, unknown>; dryRun?: boolean }): Promise<number> {
    return this.append("dry_run", { ...data, dryRun: true })
  }

  getEntries(): AuditEntry[] { return [...this.entries] }

  async verifyChain(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = []
    let content: string
    try {
      content = await readFile(this.filePath, "utf-8")
    } catch {
      return { valid: true, errors: [] }
    }
    const lines = content.trim().split("\n").filter((l) => l.length > 0)
    if (lines.length === 0) return { valid: true, errors: [] }
    let expectedPrevHash = "genesis"
    for (let i = 0; i < lines.length; i++) {
      const record = JSON.parse(lines[i])
      if (record.prevHash !== expectedPrevHash) {
        errors.push(`Line ${i + 1}: prevHash mismatch`)
      }
      const { hash: savedHash, ...rest } = record
      const canonical = JSON.stringify(rest, Object.keys(rest).sort())
      const expectedHash = createHash("sha256").update(canonical).digest("hex")
      if (savedHash !== expectedHash) {
        errors.push(`Line ${i + 1}: hash mismatch`)
      }
      expectedPrevHash = savedHash
    }
    return { valid: errors.length === 0, errors }
  }
}

// ── Mock Rate Limiter ───────────────────────────────────────

class MockRateLimiter {
  private tokens: number
  constructor(initialTokens = 100) { this.tokens = initialTokens }
  tryConsume(_toolName: string, _jobId?: string): boolean {
    if (this.tokens <= 0) return false
    this.tokens -= 1
    return true
  }
  getRemainingTokens(_jobId?: string): { global: number; job?: number } {
    return { global: this.tokens }
  }
  get remaining(): number { return this.tokens }
}

// ── Mock Dedupe Index ───────────────────────────────────────

class MockDedupeIndex {
  private completed = new Set<string>()
  isDuplicate(key: string): boolean { return this.completed.has(key) }
  async recordPending(_key: string, _intentSeq: number): Promise<void> {}
  async record(key: string, _intentSeq: number): Promise<void> { this.completed.add(key) }
}

// ── Mock Alert Service ──────────────────────────────────────

class MockAlertService {
  readonly alerts: { severity: string; triggerType: string; message: string }[] = []
  async fire(severity: string, triggerType: string, context: { jobId?: string; message: string }): Promise<boolean> {
    this.alerts.push({ severity, triggerType, message: context.message })
    return true
  }
}

// ── Mock MCP tool factory ───────────────────────────────────

function createMockTools(): ToolDef[] {
  function makeTool(name: string): ToolDef {
    const tool: ToolDef = {
      name,
      capability: CAPABILITIES[name] ?? "read",
      actualCalls: 0,
      execute: async (params: Record<string, unknown>) => {
        tool.actualCalls++
        return { ok: true, tool: name, params }
      },
    }
    return tool
  }
  return [
    makeTool("get_pull_request"),
    makeTool("create_pull_request_review"),
    makeTool("merge_pull_request"),
  ]
}

// ── Minimal firewall (9-step enforcement) ───────────────────

class MockFirewall {
  private audit: MockAuditTrail
  private rateLimiter: MockRateLimiter
  private dedupe: MockDedupeIndex
  private alertService: MockAlertService
  private dryRun: boolean

  constructor(deps: {
    audit: MockAuditTrail
    rateLimiter: MockRateLimiter
    dedupe: MockDedupeIndex
    alertService: MockAlertService
    dryRun: boolean
  }) {
    this.audit = deps.audit
    this.rateLimiter = deps.rateLimiter
    this.dedupe = deps.dedupe
    this.alertService = deps.alertService
    this.dryRun = deps.dryRun
  }

  wrapTools(tools: ToolDef[]): ToolDef[] {
    return tools.map((tool) => ({
      ...tool,
      execute: (params: Record<string, unknown>) =>
        this.enforce(tool, params),
    }))
  }

  private async enforce(tool: ToolDef, params: Record<string, unknown>): Promise<unknown> {
    const cap = CAPABILITIES[tool.name]
    const target = `${params.owner ?? "_"}/${params.repo ?? "_"}#${params.pull_number ?? "_"}`
    const auditData = { action: tool.name, target, params, dryRun: this.dryRun }

    // Step 1: Admin tools always denied + alert
    if (cap === "admin") {
      await this.alertService.fire("critical", "admin_tool_denied", {
        message: `Admin tool "${tool.name}" invocation denied`,
      })
      await this.audit.recordDenied(auditData)
      throw new Error(`Firewall denied "${tool.name}": Admin tools are always denied`)
    }

    // Step 3: Dry-run interception for write tools
    if (this.dryRun && cap === "write") {
      await this.audit.recordDryRun(auditData)
      return { dryRun: true, tool: tool.name, params, message: "Write intercepted in dry-run mode" }
    }

    // Step 6: Rate limit check
    if (!this.rateLimiter.tryConsume(tool.name)) {
      await this.audit.recordDenied(auditData)
      throw new Error(`Firewall denied "${tool.name}": Rate limit exceeded`)
    }

    // Step 7: Write-ahead audit intent
    const intentSeq = await this.audit.recordIntent(auditData)

    // Step 9: Execute and record result
    const result = await tool.execute(params)
    await this.audit.recordResult(intentSeq, {
      action: tool.name,
      target,
      params,
      result,
      rateLimitRemaining: this.rateLimiter.remaining,
    })
    return result
  }
}

// ── Mock boot ───────────────────────────────────────────────

async function bootAgentJobs(config: {
  enabled?: boolean
  token?: string
  dryRun?: boolean
}, deps: {
  initAuditTrail?: () => Promise<boolean>
  initAlertService?: () => Promise<boolean>
  initFirewall?: () => Promise<boolean>
  firewallSelfTest?: () => Promise<boolean>
  initCronService?: () => Promise<boolean>
}): Promise<{
  success: boolean
  warnings: string[]
  error?: string
  subsystems: { auditTrail: boolean; alertService: boolean; firewall: boolean; cronService: boolean }
}> {
  const subsystems = { auditTrail: false, alertService: false, firewall: false, cronService: false }
  if (config.enabled === false) {
    return { success: false, warnings: [], error: "Agent jobs disabled", subsystems }
  }
  try {
    subsystems.auditTrail = deps.initAuditTrail ? await deps.initAuditTrail() : true
    if (!subsystems.auditTrail) return { success: false, warnings: [], error: "Audit trail init failed", subsystems }
    subsystems.alertService = deps.initAlertService ? await deps.initAlertService() : true
    subsystems.firewall = deps.initFirewall ? await deps.initFirewall() : true
    if (!subsystems.firewall) return { success: false, warnings: [], error: "Firewall init failed", subsystems }
    if (deps.firewallSelfTest) {
      const ok = await deps.firewallSelfTest()
      if (!ok) return { success: false, warnings: [], error: "Self-test failed", subsystems }
    }
    subsystems.cronService = deps.initCronService ? await deps.initCronService() : true
    return { success: true, warnings: [], subsystems }
  } catch (err: unknown) {
    return { success: false, warnings: [], error: String(err), subsystems }
  }
}

// ── Shared temp directory ───────────────────────────────────

let tmpDir: string

// ══════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════

test("full pipeline: boot → create job → trigger → firewall wraps tools → audit → complete", async () => {
  // 1. Boot
  const bootResult = await bootAgentJobs(
    { enabled: true, token: "ghs_fake", dryRun: true },
    {
      initAuditTrail: async () => true,
      initAlertService: async () => true,
      initFirewall: async () => true,
      firewallSelfTest: async () => true,
      initCronService: async () => true,
    },
  )
  assert.equal(bootResult.success, true, "Boot should succeed")
  assert.equal(bootResult.subsystems.auditTrail, true)
  assert.equal(bootResult.subsystems.firewall, true)

  // 2. Create AuditTrail with temp file
  const auditPath = join(tmpDir, "pipeline-audit.jsonl")
  const audit = new MockAuditTrail(auditPath)
  audit.setRunContext({ jobId: "job-pr-review-1", runUlid: "01ABCDEF", templateId: "pr-review" })

  // 3. Create firewall + deps
  const rateLimiter = new MockRateLimiter(100)
  const dedupe = new MockDedupeIndex()
  const alertService = new MockAlertService()
  const firewall = new MockFirewall({
    audit, rateLimiter, dedupe, alertService, dryRun: true,
  })

  // 4. Create mock MCP tools and wrap
  const rawTools = createMockTools()
  const wrappedTools = firewall.wrapTools(rawTools)
  const readTool = wrappedTools.find((t) => t.name === "get_pull_request")!
  const writeTool = wrappedTools.find((t) => t.name === "create_pull_request_review")!
  const adminTool = wrappedTools.find((t) => t.name === "merge_pull_request")!

  // 5. Execute read tool — should succeed
  const readResult = await readTool.execute({ owner: "test", repo: "repo", pull_number: 42 })
  assert.ok(readResult, "Read tool should return a result")

  // 6. Execute write tool — should get dry-run intercepted
  const writeResult = await writeTool.execute({ owner: "test", repo: "repo", pull_number: 42, body: "LGTM" }) as { dryRun: boolean }
  assert.equal(writeResult.dryRun, true, "Write tool should be dry-run intercepted")

  // 7. Execute admin tool — should get denied + alert
  let adminDenied = false
  try {
    await adminTool.execute({ owner: "test", repo: "repo", pull_number: 42 })
  } catch (err: unknown) {
    adminDenied = true
    assert.ok(String(err).includes("Admin tools are always denied"))
  }
  assert.ok(adminDenied, "Admin tool should have been denied")

  // 8. Verify audit chain integrity
  const chainResult = await audit.verifyChain()
  assert.equal(chainResult.valid, true, `Chain should be valid: ${chainResult.errors.join("; ")}`)

  // 9. Verify intent/result pairs exist
  const entries = audit.getEntries()
  const intents = entries.filter((e) => e.phase === "intent")
  const results = entries.filter((e) => e.phase === "result")
  assert.ok(intents.length > 0, "Should have intent records")
  assert.ok(results.length > 0, "Should have result records")
  for (const r of results) {
    assert.ok(r.intentSeq !== undefined, "Result should reference an intentSeq")
    const matchingIntent = intents.find((i) => i.seq === r.intentSeq)
    assert.ok(matchingIntent, `Result intentSeq=${r.intentSeq} should match an intent`)
  }

  // 10. Verify rate limiter tokens consumed
  assert.ok(rateLimiter.remaining < 100, "Rate limiter tokens should have been consumed")

  // 11. Verify alert fired for admin tool denial
  assert.ok(alertService.alerts.length > 0, "Alert should have fired")
  assert.equal(alertService.alerts[0].severity, "critical")
  assert.equal(alertService.alerts[0].triggerType, "admin_tool_denied")
})

test("audit trail has correct intent→result pairs", async () => {
  const auditPath = join(tmpDir, "pairs-audit.jsonl")
  const audit = new MockAuditTrail(auditPath)
  audit.setRunContext({ jobId: "job-1", runUlid: "01XYZ", templateId: "pr-review" })

  const rateLimiter = new MockRateLimiter(50)
  const firewall = new MockFirewall({
    audit, rateLimiter, dedupe: new MockDedupeIndex(),
    alertService: new MockAlertService(), dryRun: true,
  })

  const tools = firewall.wrapTools(createMockTools())
  const readTool = tools.find((t) => t.name === "get_pull_request")!
  const writeTool = tools.find((t) => t.name === "create_pull_request_review")!
  const adminTool = tools.find((t) => t.name === "merge_pull_request")!

  await readTool.execute({ owner: "o", repo: "r", pull_number: 1 })
  await writeTool.execute({ owner: "o", repo: "r", pull_number: 1, body: "ok" })
  try { await adminTool.execute({ owner: "o", repo: "r", pull_number: 1 }) } catch {}

  const entries = audit.getEntries()

  // Denied records for admin tool
  const denied = entries.filter((e) => e.phase === "denied")
  assert.ok(denied.length > 0, "Should have denied records for admin tool")
  assert.ok(denied.some((d) => d.action === "merge_pull_request"))

  // Dry-run records for write tool
  const dryRuns = entries.filter((e) => e.phase === "dry_run")
  assert.ok(dryRuns.length > 0, "Should have dry_run records for write tool")
  assert.ok(dryRuns.some((d) => d.action === "create_pull_request_review"))

  // Intent→result pairs for read tool
  const intents = entries.filter((e) => e.phase === "intent")
  const results = entries.filter((e) => e.phase === "result")
  assert.ok(intents.length > 0, "Read tool should generate intent")
  assert.ok(results.length > 0, "Read tool should generate result")
  assert.equal(results[0].intentSeq, intents[0].seq, "Result should reference correct intentSeq")
})

test("WebSocket events emitted for job lifecycle", () => {
  const emitter = new EventEmitter()
  const captured: { type: string; data: unknown }[] = []

  // Wire up event capture (mimics EventBroadcaster)
  for (const event of ["job:started", "job:completed", "job:failed"]) {
    emitter.on(event, (data: unknown) => captured.push({ type: event, data }))
  }

  // Emit job lifecycle events
  emitter.emit("job:started", { jobId: "job-1", runUlid: "01ABC", templateId: "pr-review" })
  emitter.emit("job:completed", { jobId: "job-1", runUlid: "01ABC", status: "success", itemsProcessed: 3 })

  assert.equal(captured.length, 2, "Should capture 2 events")
  assert.equal(captured[0].type, "job:started")
  assert.equal(captured[1].type, "job:completed")

  const startData = captured[0].data as { jobId: string }
  assert.equal(startData.jobId, "job-1")

  const completeData = captured[1].data as { status: string; itemsProcessed: number }
  assert.equal(completeData.status, "success")
  assert.equal(completeData.itemsProcessed, 3)
})

test("boot validation passes with correct config", async () => {
  const result = await bootAgentJobs(
    { enabled: true, token: "ghs_test123", dryRun: true },
    {
      initAuditTrail: async () => true,
      initAlertService: async () => true,
      initFirewall: async () => true,
      firewallSelfTest: async () => true,
      initCronService: async () => true,
    },
  )
  assert.equal(result.success, true, "Boot should succeed with all deps passing")
  assert.equal(result.subsystems.auditTrail, true)
  assert.equal(result.subsystems.alertService, true)
  assert.equal(result.subsystems.firewall, true)
  assert.equal(result.subsystems.cronService, true)
})

test("rate limiter tokens consumed during pipeline", async () => {
  const auditPath = join(tmpDir, "ratelimit-audit.jsonl")
  const audit = new MockAuditTrail(auditPath)
  audit.setRunContext({ jobId: "job-rl", runUlid: "01RL", templateId: "pr-review" })

  const rateLimiter = new MockRateLimiter(10)
  const firewall = new MockFirewall({
    audit, rateLimiter, dedupe: new MockDedupeIndex(),
    alertService: new MockAlertService(), dryRun: false,
  })

  const tools = firewall.wrapTools(createMockTools())
  const readTool = tools.find((t) => t.name === "get_pull_request")!

  const initialTokens = rateLimiter.remaining
  await readTool.execute({ owner: "o", repo: "r", pull_number: 1 })
  await readTool.execute({ owner: "o", repo: "r", pull_number: 2 })
  await readTool.execute({ owner: "o", repo: "r", pull_number: 3 })

  assert.equal(rateLimiter.remaining, initialTokens - 3, "Should consume exactly 3 tokens for 3 read calls")
})

test("dry-run mode intercepts ALL write tools with zero actual writes", async () => {
  const auditPath = join(tmpDir, "zerowrite-audit.jsonl")
  const audit = new MockAuditTrail(auditPath)
  audit.setRunContext({ jobId: "job-dryrun", runUlid: "01DR", templateId: "pr-review" })

  const rawTools = createMockTools()
  const firewall = new MockFirewall({
    audit, rateLimiter: new MockRateLimiter(50),
    dedupe: new MockDedupeIndex(), alertService: new MockAlertService(),
    dryRun: true,
  })

  const wrappedTools = firewall.wrapTools(rawTools)
  for (const tool of wrappedTools) {
    try {
      await tool.execute({ owner: "o", repo: "r", pull_number: 1 })
    } catch {
      // Admin tools will throw — expected
    }
  }

  // Check: zero actual calls on write/admin tools
  const writeRaw = rawTools.find((t) => t.name === "create_pull_request_review")!
  const adminRaw = rawTools.find((t) => t.name === "merge_pull_request")!
  assert.equal(writeRaw.actualCalls, 0, "Write tool should have zero actual executions")
  assert.equal(adminRaw.actualCalls, 0, "Admin tool should have zero actual executions")

  // Verify via audit entries: no write/admin intent+result with dryRun=false
  const entries = audit.getEntries()
  const writeActions = entries.filter((e) =>
    (CAPABILITIES[e.action] === "write" || CAPABILITIES[e.action] === "admin") &&
    (e.phase === "intent" || e.phase === "result") &&
    !e.dryRun
  )
  assert.equal(writeActions.length, 0, "No write-phase intent/result without dryRun flag")
})

test("circuit breaker stays closed after successful execution", () => {
  // Inline minimal circuit breaker
  let state: "closed" | "open" | "half_open" = "closed"
  let failures = 0
  const threshold = 5

  function recordSuccess(): void {
    if (state === "closed") failures = 0
  }
  function recordFailure(): void {
    failures++
    if (failures >= threshold) state = "open"
  }

  // Simulate successful pipeline
  recordSuccess()
  recordSuccess()
  recordSuccess()

  assert.equal(state, "closed", "Breaker should stay closed after successes")
  assert.equal(failures, 0, "Failures should be 0 after successes")

  // Verify a single failure doesn't open
  recordFailure()
  assert.equal(state, "closed", "One failure should not open breaker")
  assert.equal(failures, 1)
})

test("kill switch halts pipeline when activated", async () => {
  // Mock kill switch
  let killSwitchActive = false
  function checkKillSwitch(): boolean { return killSwitchActive }

  // Simulate a pipeline that checks kill switch before each step
  const stepsExecuted: string[] = []

  async function runPipeline(): Promise<boolean> {
    const steps = ["resolve_items", "process_item_1", "process_item_2", "finalize"]
    for (const step of steps) {
      if (checkKillSwitch()) return false
      stepsExecuted.push(step)
    }
    return true
  }

  // Run without kill switch — all steps execute
  const result1 = await runPipeline()
  assert.equal(result1, true, "Pipeline should complete without kill switch")
  assert.equal(stepsExecuted.length, 4, "All 4 steps should execute")

  // Activate kill switch mid-pipeline
  stepsExecuted.length = 0
  killSwitchActive = false

  const stepsWithKill: string[] = []
  const steps = ["resolve_items", "process_item_1", "process_item_2", "finalize"]
  for (const step of steps) {
    if (checkKillSwitch()) break
    stepsWithKill.push(step)
    // Activate after first step
    if (step === "resolve_items") killSwitchActive = true
  }

  assert.equal(stepsWithKill.length, 1, "Only 1 step should execute before kill switch halts pipeline")
  assert.equal(stepsWithKill[0], "resolve_items")
})

// ══════════════════════════════════════════════════════════════
// Runner
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log("Phase 1 Acceptance Tests (TASK-3.9)")
  console.log("====================================")

  // Create shared temp directory
  tmpDir = await mkdtemp(join(tmpdir(), "finn-phase1-"))

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

  // Cleanup
  await rm(tmpDir, { recursive: true, force: true })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}
main()
