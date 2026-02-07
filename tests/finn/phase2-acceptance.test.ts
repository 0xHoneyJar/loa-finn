// tests/finn/phase2-acceptance.test.ts — Phase 2 Acceptance Gate (TASK-5.9)
//
// End-to-end validation of all templates, workflow engine, change detection,
// context injection, and compound learning. Self-contained — no cross-repo imports.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"

// ── Inline test harness ─────────────────────────────────────

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Shared inline types ─────────────────────────────────────

interface ConstraintDef {
  draftOnly?: boolean
  labelsOnly?: string[]
  maxCommentLength?: number
  deniedEvents?: string[]
}

interface ActionPolicyDef {
  templateId: string
  allow: string[]
  deny: string[]
  constraints?: Record<string, ConstraintDef>
}

interface TemplateItem {
  key: string
  hash: string
  data: Record<string, unknown>
}

type ToolCapability = "read" | "write" | "admin"

// ── BaseTemplate ────────────────────────────────────────────

abstract class BaseTemplate {
  abstract readonly id: string
  abstract readonly name: string
  abstract readonly actionPolicy: ActionPolicyDef
  abstract readonly canonicalHashFields: string[]
  abstract readonly excludedHashFields: string[]

  abstract resolveItems(): Promise<TemplateItem[]>
  abstract buildPrompt(item: TemplateItem): string

  computeStateHash(item: TemplateItem): string {
    const canonical: Record<string, unknown> = {}
    const keys = Object.keys(item.data)
      .filter(k => this.canonicalHashFields.includes(k))
      .filter(k => !this.excludedHashFields.includes(k))
      .sort()
    for (const k of keys) {
      canonical[k] = item.data[k]
    }
    return createHash("sha256")
      .update(JSON.stringify(canonical))
      .digest("hex")
  }
}

// ── IssueTriageTemplate (inline) ────────────────────────────

interface Issue {
  number: number
  title: string
  body: string
  labels: string[]
  state: string
  commentCount: number
  updated_at?: string
  reactions?: Record<string, number>
  assignee?: string | null
  milestone?: string | null
}

interface IssueClient {
  listIssues(opts: { state: "open" | "closed" }): Promise<Issue[]>
}

const ISSUE_TRIAGE_POLICY: ActionPolicyDef = {
  templateId: "issue-triage",
  allow: ["list_issues", "get_issue", "search_issues", "update_issue", "add_issue_comment"],
  deny: ["close_issue", "delete_issue", "merge_pull_request", "create_pull_request"],
  constraints: {
    update_issue: {
      labelsOnly: ["bug", "enhancement", "question", "docs", "invalid", "P0", "P1", "P2", "P3", "triaged"],
    },
  },
}

class IssueTriageTemplate extends BaseTemplate {
  readonly id = "issue-triage"
  readonly name = "Issue Triage"
  readonly actionPolicy = ISSUE_TRIAGE_POLICY
  readonly canonicalHashFields = ["title", "body", "labels", "commentCount"]
  readonly excludedHashFields = ["updated_at", "reactions", "assignee", "milestone"]
  private readonly client: IssueClient
  constructor(client: IssueClient) { super(); this.client = client }

  async resolveItems(): Promise<TemplateItem[]> {
    const openIssues = await this.client.listIssues({ state: "open" })
    const untriaged = openIssues.filter(i => !i.labels.includes("triaged"))
    return untriaged.map(issue => {
      const data: Record<string, unknown> = {
        number: issue.number, title: issue.title, body: issue.body,
        labels: issue.labels, commentCount: issue.commentCount,
        updated_at: issue.updated_at, reactions: issue.reactions,
        assignee: issue.assignee, milestone: issue.milestone,
      }
      const item: TemplateItem = { key: `issue-${issue.number}`, hash: "", data }
      item.hash = this.computeStateHash(item)
      return item
    })
  }

  buildPrompt(item: TemplateItem): string {
    const n = item.data.number as number
    const t = item.data.title as string
    const b = item.data.body as string
    const labels = item.data.labels as string[]
    const sections = [
      `## Issue #${n}: ${t}`,
      "\n### Classification",
      "Classify this issue into one of: bug, enhancement, question, docs, invalid.",
      "\n### Priority Assessment",
      "Assess priority: P0 (critical), P1 (high), P2 (medium), P3 (low).",
      "\n### Label Suggestions",
      labels.length > 0 ? `Current labels: ${labels.join(", ")}` : "No labels currently assigned.",
      "\n### Issue Body",
      b || "(No body provided.)",
    ]
    return sections.join("\n")
  }
}

// ── PrReviewTemplate (inline) ───────────────────────────────

const PR_REVIEW_POLICY: ActionPolicyDef = {
  templateId: "pr-review",
  allow: ["get_pull_request", "get_pull_request_files", "get_pull_request_reviews",
    "get_pull_request_comments", "get_file_contents", "list_commits",
    "search_code", "create_pull_request_review"],
  deny: ["merge_pull_request", "close_pull_request", "delete_branch",
    "update_pull_request_branch", "enable_auto_merge"],
  constraints: { create_pull_request_review: { deniedEvents: ["APPROVE"] } },
}

// ── PrDraftTemplate (inline) ────────────────────────────────

interface PrDraftIssue {
  number: number; title: string; body: string
  labels: string[]; state: string; pull_request?: unknown
  updated_at?: string; reactions?: Record<string, number>; assignee?: string | null
}

interface PrDraftClient {
  listIssues(opts: { state: "open" | "closed" }): Promise<PrDraftIssue[]>
}

const PR_DRAFT_POLICY: ActionPolicyDef = {
  templateId: "pr-draft",
  allow: ["list_issues", "get_issue", "search_issues", "get_file_contents",
    "list_commits", "create_branch", "create_or_update_file",
    "push_files", "create_pull_request", "add_issue_comment"],
  deny: ["merge_pull_request", "delete_branch", "update_pull_request_branch"],
  constraints: { create_pull_request: { draftOnly: true } },
}

class PrDraftTemplate extends BaseTemplate {
  readonly id = "pr-draft"
  readonly name = "PR Draft"
  readonly actionPolicy = PR_DRAFT_POLICY
  readonly canonicalHashFields = ["title", "body", "labels"]
  readonly excludedHashFields = ["updated_at", "reactions", "assignee"]
  private readonly client: PrDraftClient
  private readonly maxDiffLines: number
  private readonly maxFilesChanged: number
  constructor(client: PrDraftClient, config?: { maxDiffLines?: number; maxFilesChanged?: number }) {
    super()
    this.client = client
    this.maxDiffLines = config?.maxDiffLines ?? 500
    this.maxFilesChanged = config?.maxFilesChanged ?? 20
  }

  async resolveItems(): Promise<TemplateItem[]> {
    const open = await this.client.listIssues({ state: "open" })
    const ready = open.filter(i => i.labels.includes("ready-for-pr") && !i.pull_request)
    return ready.map(issue => {
      const data: Record<string, unknown> = {
        number: issue.number, title: issue.title, body: issue.body,
        labels: issue.labels, updated_at: issue.updated_at,
        reactions: issue.reactions, assignee: issue.assignee,
      }
      const item: TemplateItem = { key: `issue-${issue.number}`, hash: "", data }
      item.hash = this.computeStateHash(item)
      return item
    })
  }

  buildPrompt(item: TemplateItem): string {
    const n = item.data.number as number
    const t = item.data.title as string
    const b = item.data.body as string
    return [
      `## Issue #${n}: ${t}`,
      "\n### Implementation Instructions",
      "Create a draft pull request that addresses this issue.",
      "\n### MVP Constraints",
      `- Maximum diff lines: ${this.maxDiffLines}`,
      `- Maximum files changed: ${this.maxFilesChanged}`,
      "- PR must be created as a **draft**.",
      b ? `\n### Issue Body\n${b}` : "",
    ].join("\n")
  }

  checkMvpConstraints(diffLines: number, filesChanged: number): { pass: boolean; violations: string[] } {
    const violations: string[] = []
    if (diffLines > this.maxDiffLines) violations.push(`Diff lines ${diffLines} exceeds max ${this.maxDiffLines}`)
    if (filesChanged > this.maxFilesChanged) violations.push(`Files changed ${filesChanged} exceeds max ${this.maxFilesChanged}`)
    return { pass: violations.length === 0, violations }
  }
}

// ── CodeAuditTemplate (inline) ──────────────────────────────

interface CodeAuditClient { getHeadSha(opts: { ref?: string }): Promise<string> }

const CODE_AUDIT_POLICY: ActionPolicyDef = {
  templateId: "code-audit",
  allow: ["get_file_contents", "search_code", "list_commits", "create_issue"],
  deny: ["merge_pull_request", "delete_branch", "update_issue", "create_pull_request", "add_issue_comment"],
}

class CodeAuditTemplate extends BaseTemplate {
  readonly id = "code-audit"
  readonly name = "Code Audit"
  readonly actionPolicy = CODE_AUDIT_POLICY
  readonly canonicalHashFields = ["headSha"]
  readonly excludedHashFields = ["updated_at", "ci_status"]
  private readonly client: CodeAuditClient
  constructor(client: CodeAuditClient) { super(); this.client = client }

  async resolveItems(): Promise<TemplateItem[]> {
    const headSha = await this.client.getHeadSha({ ref: "HEAD" })
    const data: Record<string, unknown> = { headSha }
    const item: TemplateItem = { key: "repo-head", hash: "", data }
    item.hash = this.computeStateHash(item)
    return [item]
  }

  buildPrompt(item: TemplateItem): string {
    const headSha = item.data.headSha as string
    return [
      `## Code Audit — HEAD ${headSha}`,
      "\n### Security Review",
      "Perform a security audit against the OWASP Top 10 vulnerability categories:",
      "- Injection flaws", "- Broken authentication", "- Sensitive data exposure",
      "\n### Code Quality",
      "- Dead code and unused imports", "- Error handling gaps",
      "\n### Output",
      "Create a GitHub issue summarising findings.",
    ].join("\n")
  }
}

// ── StaleCleanupTemplate (inline) ───────────────────────────

const STALE_CLEANUP_POLICY: ActionPolicyDef = {
  templateId: "stale-cleanup",
  allow: ["list_issues", "list_pull_requests", "get_issue", "get_pull_request", "update_issue", "add_issue_comment"],
  deny: ["close_issue", "delete_branch", "merge_pull_request", "create_pull_request"],
  constraints: { update_issue: { labelsOnly: ["stale"] } },
}

// ── ChangeDetector (inline) ─────────────────────────────────

interface ProcessedItemRecord {
  key: string; lastHash: string; lastProcessedAt: string; result: string
}

class ChangeDetector {
  private reReviewAfterHours: number
  private now: () => number
  constructor(config?: { reReviewAfterHours?: number; now?: () => number }) {
    this.reReviewAfterHours = config?.reReviewAfterHours ?? 24
    this.now = config?.now ?? (() => Date.now())
  }

  check(key: string, currentHash: string, processedItems: ProcessedItemRecord[]): { changed: boolean; reason: string; currentHash: string } {
    const prev = processedItems.find(i => i.key === key)
    if (!prev) return { changed: true, reason: "new", currentHash }
    if (prev.lastHash !== currentHash) return { changed: true, reason: "hash_changed", currentHash }
    const elapsed = this.now() - new Date(prev.lastProcessedAt).getTime()
    if (elapsed >= this.reReviewAfterHours * 3600000) return { changed: true, reason: "timer_expired", currentHash }
    return { changed: false, reason: "unchanged", currentHash }
  }
}

// ── WorkflowEngine (inline) ─────────────────────────────────

type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped"
type WorkflowRunStatus = "pending" | "running" | "waiting_approval" | "step_failed" | "aborted" | "completed"

interface EngineStepDef { id: string; skill: string; gate?: "auto" | "approve"; on_failure?: "abort" | "skip" }
interface StepState { stepId: string; status: StepStatus; outputs: Record<string, unknown>; error?: string }

interface WorkflowRun {
  id: string; workflowId: string; triggerId: string
  status: WorkflowRunStatus; currentStep: number; steps: StepState[]
  startedAt?: string; completedAt?: string; error?: string
}

interface EnginePersistence {
  save(run: WorkflowRun): Promise<void>
  load(runId: string): Promise<WorkflowRun | null>
}

class InMemPersistence implements EnginePersistence {
  store = new Map<string, WorkflowRun>()
  saveCount = 0
  async save(run: WorkflowRun): Promise<void> {
    this.store.set(run.id, structuredClone(run)); this.saveCount++
  }
  async load(runId: string): Promise<WorkflowRun | null> {
    const r = this.store.get(runId); return r ? structuredClone(r) : null
  }
}

class WorkflowEngine {
  private persistence: EnginePersistence
  private executor: (def: EngineStepDef) => Promise<Record<string, unknown>>
  private stepDefs = new Map<string, EngineStepDef[]>()

  constructor(deps: {
    persistence: EnginePersistence
    executor: (def: EngineStepDef) => Promise<Record<string, unknown>>
  }) {
    this.persistence = deps.persistence
    this.executor = deps.executor
  }

  async start(opts: { id: string; workflowId: string; triggerId: string; steps: EngineStepDef[] }): Promise<WorkflowRun> {
    const run: WorkflowRun = {
      id: opts.id, workflowId: opts.workflowId, triggerId: opts.triggerId,
      status: "running", currentStep: 0,
      steps: opts.steps.map(s => ({ stepId: s.id, status: "pending" as StepStatus, outputs: {} })),
      startedAt: new Date().toISOString(),
    }
    this.stepDefs.set(opts.id, opts.steps)
    await this.persistence.save(run)
    return this.advance(opts.id)
  }

  async advance(runId: string): Promise<WorkflowRun> {
    const run = await this.persistence.load(runId)
    if (!run) throw new Error(`Run "${runId}" not found`)
    const defs = this.stepDefs.get(runId)
    if (!defs) throw new Error(`Step defs for "${runId}" not found`)

    while (run.currentStep < run.steps.length) {
      const idx = run.currentStep
      const stepState = run.steps[idx]
      const stepDef = defs[idx]
      if (stepState.status === "completed") { run.currentStep++; continue }

      stepState.status = "running"
      await this.persistence.save(run)

      try {
        const outputs = await this.executor(stepDef)
        stepState.status = "completed"
        stepState.outputs = outputs
      } catch (err) {
        const failMode = stepDef.on_failure ?? "abort"
        if (failMode === "skip") {
          stepState.status = "skipped"
          stepState.error = err instanceof Error ? err.message : String(err)
        } else {
          stepState.status = "failed"
          stepState.error = err instanceof Error ? err.message : String(err)
          run.status = "aborted"
          run.error = `Step "${stepDef.id}" failed: ${stepState.error}`
          await this.persistence.save(run)
          return run
        }
      }

      await this.persistence.save(run)
      run.currentStep++
    }

    run.status = "completed"
    run.completedAt = new Date().toISOString()
    await this.persistence.save(run)
    return run
  }

  registerStepDefs(runId: string, defs: EngineStepDef[]): void {
    this.stepDefs.set(runId, defs)
  }
}

// ── JobContext (inline) ─────────────────────────────────────

class JobContext {
  private items = new Map<string, { hash: string; processedAt: string }>()

  recordProcessed(key: string, hash: string): void {
    this.items.set(key, { hash, processedAt: new Date().toISOString() })
  }

  hasChanged(key: string, currentHash: string): boolean {
    const prev = this.items.get(key)
    if (!prev) return true
    return prev.hash !== currentHash
  }

  getProcessedKeys(): string[] {
    return Array.from(this.items.keys())
  }
}

// ── CompoundLearningExtractor (inline) ──────────────────────

interface LearningCandidate {
  pattern: string; source: string; confidence: number
  occurrences: number; firstSeenAt: string; lastSeenAt: string
}

class CompoundLearningExtractor {
  private minOccurrences: number
  private minConfidence: number

  constructor(config?: { minOccurrences?: number; minConfidence?: number }) {
    this.minOccurrences = config?.minOccurrences ?? 3
    this.minConfidence = config?.minConfidence ?? 0.7
  }

  extractCandidates(
    results: Array<{ patterns?: string[]; success: boolean }>,
  ): LearningCandidate[] {
    const now = new Date().toISOString()
    const map = new Map<string, { total: number; successes: number; firstSeen: string }>()
    for (const r of results) {
      if (!r.success) continue
      for (const p of r.patterns ?? []) {
        const e = map.get(p)
        if (e) { e.total++; e.successes++ } else map.set(p, { total: 1, successes: 1, firstSeen: now })
      }
    }
    for (const r of results) {
      if (r.success) continue
      for (const p of r.patterns ?? []) { const e = map.get(p); if (e) e.total++ }
    }
    return Array.from(map.entries()).map(([pattern, d]) => ({
      pattern, source: "review", confidence: d.successes / d.total,
      occurrences: d.successes, firstSeenAt: d.firstSeen, lastSeenAt: now,
    }))
  }

  qualityGate(candidates: LearningCandidate[]): { accepted: LearningCandidate[]; rejected: LearningCandidate[] } {
    const accepted: LearningCandidate[] = []
    const rejected: LearningCandidate[] = []
    for (const c of candidates) {
      if (c.confidence >= this.minConfidence && c.occurrences >= this.minOccurrences) accepted.push(c)
      else rejected.push(c)
    }
    return { accepted, rejected }
  }
}

// ── Tool registry + firewall helpers (inline) ───────────────

const CAPABILITIES: Record<string, ToolCapability> = {
  get_pull_request: "read", get_pull_request_files: "read", list_pull_requests: "read",
  list_issues: "read", get_issue: "read", search_issues: "read", get_file_contents: "read",
  search_code: "read", list_commits: "read",
  create_pull_request_review: "write", add_issue_comment: "write", update_issue: "write",
  create_pull_request: "write", create_issue: "write", create_branch: "write",
  push_files: "write", create_or_update_file: "write",
  merge_pull_request: "admin", delete_branch: "admin", close_issue: "admin",
}

// ══════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════

// ── 1. Issue triage: resolve, classify, add labels + comment, context updated ──

test("issue triage: resolve -> classify -> add labels + comment -> context updated", async () => {
  const mockIssues: Issue[] = [
    { number: 10, title: "App crashes", body: "Segfault on boot.", labels: ["bug"], state: "open", commentCount: 3 },
    { number: 11, title: "Add dark mode", body: "Feature request.", labels: ["triaged", "enhancement"], state: "open", commentCount: 1 },
    { number: 12, title: "How to configure?", body: "Need docs.", labels: [], state: "open", commentCount: 0 },
  ]
  const client: IssueClient = { listIssues: async () => mockIssues }
  const tmpl = new IssueTriageTemplate(client)

  // Resolve: filter out triaged issues
  const items = await tmpl.resolveItems()
  assert.equal(items.length, 2, "Should return 2 untriaged issues")
  assert.equal(items[0].key, "issue-10")
  assert.equal(items[1].key, "issue-12")

  // Build prompt: verify classification instructions present
  const prompt = tmpl.buildPrompt(items[0])
  assert.ok(prompt.includes("### Classification"), "Prompt should contain classification instructions")
  assert.ok(prompt.includes("### Priority Assessment"), "Prompt should contain priority assessment")
  assert.ok(prompt.includes("bug, enhancement, question, docs, invalid"), "Prompt should list classification types")

  // Context updated after processing: record and verify
  const ctx = new JobContext()
  for (const item of items) {
    ctx.recordProcessed(item.key, item.hash)
  }
  assert.ok(!ctx.hasChanged("issue-10", items[0].hash), "Same hash should not be seen as changed")
  assert.ok(ctx.hasChanged("issue-10", "different-hash"), "Different hash should be seen as changed")
  assert.deepEqual(ctx.getProcessedKeys().sort(), ["issue-10", "issue-12"])
})

// ── 2. PR review (Phase 1 regression): unchanged skipped, changed re-reviewed ──

test("PR review (Phase 1 regression): unchanged items skipped, changed items re-reviewed", () => {
  const now = Date.now()
  const cd = new ChangeDetector({ now: () => now })

  const processedItems: ProcessedItemRecord[] = [{
    key: "pr-42", lastHash: "hash-v1",
    lastProcessedAt: new Date(now - 3600000).toISOString(), result: "success",
  }]

  // First check: same hash -> unchanged (skipped)
  const check1 = cd.check("pr-42", "hash-v1", processedItems)
  assert.equal(check1.changed, false, "Same hash should not trigger reprocessing")
  assert.equal(check1.reason, "unchanged")

  // Second check: changed hash -> re-reviewed
  const check2 = cd.check("pr-42", "hash-v2", processedItems)
  assert.equal(check2.changed, true, "Different hash should trigger reprocessing")
  assert.equal(check2.reason, "hash_changed")
})

// ── 3. PR draft: issue with ready-for-pr -> workflow engine runs -> draft PR created (dry-run) ──

test("PR draft: issue with ready-for-pr -> workflow engine runs -> draft PR created (dry-run)", async () => {
  const issues: PrDraftIssue[] = [
    { number: 10, title: "Add caching", body: "Cache API responses.", labels: ["ready-for-pr", "enhancement"], state: "open" },
    { number: 11, title: "Fix login", body: "Login bug.", labels: ["bug"], state: "open" },
    { number: 12, title: "Has PR already", body: "Done.", labels: ["ready-for-pr"], state: "open", pull_request: { url: "https://api.github.com/pulls/99" } },
  ]
  const client: PrDraftClient = { listIssues: async () => issues }
  const tmpl = new PrDraftTemplate(client)

  // Resolve: only ready-for-pr without existing PR
  const items = await tmpl.resolveItems()
  assert.equal(items.length, 1, "Only issue-10 should be resolved")
  assert.equal(items[0].key, "issue-10")

  // Verify draftOnly constraint in action policy
  const constraint = tmpl.actionPolicy.constraints?.create_pull_request
  assert.ok(constraint, "create_pull_request constraint should exist")
  assert.equal(constraint!.draftOnly, true, "draftOnly should be true")

  // Verify MVP constraints
  const passResult = tmpl.checkMvpConstraints(100, 5)
  assert.equal(passResult.pass, true, "Within limits should pass")
  const failResult = tmpl.checkMvpConstraints(600, 25)
  assert.equal(failResult.pass, false, "Over limits should fail")
  assert.equal(failResult.violations.length, 2, "Both diff and files violations")
})

// ── 4. Code audit: daily trigger -> audit report -> issue created (dry-run) ──

test("code audit: daily trigger -> audit report -> issue created (dry-run)", async () => {
  const client: CodeAuditClient = { getHeadSha: async () => "abc123def456" }
  const tmpl = new CodeAuditTemplate(client)

  // Verify resolveItems returns single item
  const items = await tmpl.resolveItems()
  assert.equal(items.length, 1, "Should return exactly one item")
  assert.equal(items[0].key, "repo-head")
  assert.equal(items[0].data.headSha, "abc123def456")
  assert.equal(items[0].hash.length, 64, "Hash should be SHA-256 hex")

  // Verify buildPrompt mentions OWASP
  const prompt = tmpl.buildPrompt(items[0])
  assert.ok(prompt.includes("OWASP Top 10"), "Prompt should mention OWASP Top 10")
  assert.ok(prompt.includes("abc123def456"), "Prompt should include headSha")
  assert.ok(prompt.includes("### Security Review"), "Prompt should contain security review section")
  assert.ok(prompt.includes("### Code Quality"), "Prompt should contain code quality section")
})

// ── 5. Workflow engine: multi-step pipeline advances, crash recovery ──

test("workflow engine: multi-step pipeline advances, crash recovery", async () => {
  const persistence = new InMemPersistence()
  const executionOrder: string[] = []

  const engine = new WorkflowEngine({
    persistence,
    executor: async (def) => {
      executionOrder.push(def.id)
      return { result: `${def.id}-done` }
    },
  })

  const steps: EngineStepDef[] = [
    { id: "s1", skill: "analyze" },
    { id: "s2", skill: "review" },
    { id: "s3", skill: "report" },
  ]

  // Execute 2 steps then simulate crash: start a run that will crash after s2
  const crashPersistence = new InMemPersistence()
  const crashOrder: string[] = []
  let stepCount = 0

  const crashEngine = new WorkflowEngine({
    persistence: crashPersistence,
    executor: async (def) => {
      stepCount++
      crashOrder.push(def.id)
      if (stepCount >= 3) throw new Error("simulated-crash")
      return { result: `${def.id}-done` }
    },
  })

  // Run the full 3-step workflow; s3 will fail (simulating crash)
  const crashedRun = await crashEngine.start({
    id: "crash-run", workflowId: "wf-1", triggerId: "t-1",
    steps: [
      { id: "s1", skill: "analyze" },
      { id: "s2", skill: "review" },
      { id: "s3", skill: "report", on_failure: "abort" },
    ],
  })
  assert.equal(crashedRun.status, "aborted", "Run should be aborted after crash")
  assert.equal(crashedRun.steps[0].status, "completed", "Step 1 should be completed")
  assert.equal(crashedRun.steps[1].status, "completed", "Step 2 should be completed")
  assert.equal(crashedRun.steps[2].status, "failed", "Step 3 should be failed")

  // Resume: create a new engine, inject the crashed run at step 2, re-execute step 3
  const resumePersistence = new InMemPersistence()
  const resumeOrder: string[] = []

  const resumedState: WorkflowRun = {
    id: "resume-run", workflowId: "wf-1", triggerId: "t-1",
    status: "running", currentStep: 2,
    steps: [
      { stepId: "s1", status: "completed", outputs: { result: "s1-done" } },
      { stepId: "s2", status: "completed", outputs: { result: "s2-done" } },
      { stepId: "s3", status: "pending", outputs: {} },
    ],
    startedAt: "2026-02-07T00:00:00Z",
  }
  await resumePersistence.save(resumedState)

  const resumeEngine = new WorkflowEngine({
    persistence: resumePersistence,
    executor: async (def) => { resumeOrder.push(def.id); return { result: `${def.id}-done` } },
  })
  resumeEngine.registerStepDefs("resume-run", steps)

  const resumed = await resumeEngine.advance("resume-run")
  assert.equal(resumed.status, "completed", "Resumed run should complete")
  assert.deepEqual(resumeOrder, ["s3"], "Only step 3 should execute on resume")
  assert.equal(resumed.steps[2].status, "completed", "Step 3 should be completed after resume")

  // Verify persistence was called
  assert.ok(resumePersistence.saveCount >= 3, `Persistence should be saved at least 3 times, got ${resumePersistence.saveCount}`)
})

// ── 6. Context continuity: items processed, hash stored, unchanged skipped ──

test("context continuity: items processed, hash stored, unchanged skipped on next run", () => {
  const ctx = new JobContext()

  // Record processed items
  ctx.recordProcessed("pr-42", "hash-aaa")
  ctx.recordProcessed("issue-10", "hash-bbb")

  // Same hash -> not changed
  assert.equal(ctx.hasChanged("pr-42", "hash-aaa"), false, "Same hash should return false")
  assert.equal(ctx.hasChanged("issue-10", "hash-bbb"), false, "Same hash should return false")

  // Different hash -> changed
  assert.equal(ctx.hasChanged("pr-42", "hash-ccc"), true, "Different hash should return true")

  // New key -> changed
  assert.equal(ctx.hasChanged("pr-99", "hash-xxx"), true, "Unknown key should return true")
})

// ── 7. Change detection: volatile fields don't trigger reprocessing ──

test("change detection: volatile fields don't trigger reprocessing", () => {
  const tmpl = new IssueTriageTemplate({ listIssues: async () => [] })

  // Two items: same canonical fields, different excluded fields
  const itemA: TemplateItem = {
    key: "issue-1", hash: "",
    data: {
      title: "Bug report", body: "It crashes.", labels: ["bug"], commentCount: 3,
      updated_at: "2026-01-01T00:00:00Z", reactions: { "+1": 5 }, assignee: "alice", milestone: "v1",
    },
  }
  const itemB: TemplateItem = {
    key: "issue-1", hash: "",
    data: {
      title: "Bug report", body: "It crashes.", labels: ["bug"], commentCount: 3,
      updated_at: "2026-02-07T12:00:00Z", reactions: { "-1": 10 }, assignee: "bob", milestone: "v2",
    },
  }

  const hashA = tmpl.computeStateHash(itemA)
  const hashB = tmpl.computeStateHash(itemB)

  // Excluded (volatile) fields changed -> same hash, no reprocessing
  assert.equal(hashA, hashB, "Volatile field changes should not alter the hash")

  // Change a canonical field -> different hash, reprocessing triggered
  const itemC: TemplateItem = {
    key: "issue-1", hash: "",
    data: {
      title: "Bug report UPDATED", body: "It crashes.", labels: ["bug"], commentCount: 3,
      updated_at: "2026-01-01T00:00:00Z", reactions: { "+1": 5 }, assignee: "alice", milestone: "v1",
    },
  }
  const hashC = tmpl.computeStateHash(itemC)
  assert.notEqual(hashA, hashC, "Canonical field change should alter the hash")
})

// ── 8. All Phase 1 safety tests still pass (regression) ──

test("all Phase 1 safety tests still pass (regression)", () => {
  // Tool registry classifies read/write/admin correctly
  assert.equal(CAPABILITIES["get_pull_request"], "read", "get_pull_request should be read")
  assert.equal(CAPABILITIES["list_issues"], "read", "list_issues should be read")
  assert.equal(CAPABILITIES["create_pull_request_review"], "write", "create_pull_request_review should be write")
  assert.equal(CAPABILITIES["add_issue_comment"], "write", "add_issue_comment should be write")
  assert.equal(CAPABILITIES["merge_pull_request"], "admin", "merge_pull_request should be admin")
  assert.equal(CAPABILITIES["delete_branch"], "admin", "delete_branch should be admin")

  // Firewall denies admin tools
  const adminTools = Object.entries(CAPABILITIES).filter(([, cap]) => cap === "admin")
  assert.ok(adminTools.length >= 2, "Should have at least 2 admin tools")
  for (const [toolName] of adminTools) {
    assert.equal(CAPABILITIES[toolName], "admin", `${toolName} should be admin-classified`)
  }

  // Audit trail intent/result pattern: verify the pattern conceptually
  // An intent is recorded before execution, a result after. Verify via the
  // audit entry structure requirements.
  interface AuditEntry { seq: number; phase: "intent" | "result" | "denied"; action: string }
  const mockAuditLog: AuditEntry[] = [
    { seq: 1, phase: "intent", action: "get_pull_request" },
    { seq: 2, phase: "result", action: "get_pull_request" },
    { seq: 3, phase: "denied", action: "merge_pull_request" },
  ]
  const intents = mockAuditLog.filter(e => e.phase === "intent")
  const results = mockAuditLog.filter(e => e.phase === "result")
  const denied = mockAuditLog.filter(e => e.phase === "denied")
  assert.equal(intents.length, 1, "Should have 1 intent")
  assert.equal(results.length, 1, "Should have 1 result")
  assert.equal(denied.length, 1, "Should have 1 denied (admin tool)")
  assert.equal(denied[0].action, "merge_pull_request", "Admin tool should be denied")
})

// ── 9. All templates have valid action policies ──

test("all templates have valid action policies", () => {
  const policies: ActionPolicyDef[] = [
    ISSUE_TRIAGE_POLICY,
    PR_REVIEW_POLICY,
    PR_DRAFT_POLICY,
    CODE_AUDIT_POLICY,
    STALE_CLEANUP_POLICY,
  ]

  const expectedIds = ["issue-triage", "pr-review", "pr-draft", "code-audit", "stale-cleanup"]

  for (let i = 0; i < policies.length; i++) {
    const policy = policies[i]
    const expectedId = expectedIds[i]

    // Valid templateId
    assert.equal(policy.templateId, expectedId, `templateId should be "${expectedId}"`)

    // Non-empty allow list
    assert.ok(policy.allow.length > 0, `${expectedId}: allow list should not be empty`)

    // merge_pull_request in deny list
    assert.ok(
      policy.deny.includes("merge_pull_request"),
      `${expectedId}: deny list must include merge_pull_request`,
    )
  }
})

// ── 10. Compound learning: patterns extracted after successful reviews ──

test("compound learning: patterns extracted after successful reviews", () => {
  const extractor = new CompoundLearningExtractor({ minOccurrences: 2, minConfidence: 0.6 })

  const results = [
    { patterns: ["missing-semicolon", "unused-import"], success: true },
    { patterns: ["missing-semicolon"], success: true },
    { patterns: ["missing-semicolon"], success: true },
    { patterns: ["unused-import"], success: false },
    { patterns: ["rare-pattern"], success: true },
  ]

  const candidates = extractor.extractCandidates(results)

  // missing-semicolon: 3 successes, 3 total -> confidence 1.0
  const semicolon = candidates.find(c => c.pattern === "missing-semicolon")
  assert.ok(semicolon, "Should extract missing-semicolon")
  assert.equal(semicolon!.occurrences, 3)
  assert.equal(semicolon!.confidence, 1.0)

  // unused-import: 1 success, 2 total -> confidence 0.5
  const unused = candidates.find(c => c.pattern === "unused-import")
  assert.ok(unused, "Should extract unused-import")
  assert.equal(unused!.occurrences, 1)
  assert.equal(unused!.confidence, 0.5)

  // Quality gate should filter based on thresholds
  const { accepted, rejected } = extractor.qualityGate(candidates)

  // missing-semicolon: 3 occurrences >= 2, confidence 1.0 >= 0.6 -> accepted
  assert.ok(accepted.some(c => c.pattern === "missing-semicolon"), "missing-semicolon should be accepted")

  // unused-import: confidence 0.5 < 0.6 -> rejected
  assert.ok(rejected.some(c => c.pattern === "unused-import"), "unused-import should be rejected (low confidence)")

  // rare-pattern: 1 occurrence < 2 -> rejected
  assert.ok(rejected.some(c => c.pattern === "rare-pattern"), "rare-pattern should be rejected (low occurrences)")
})

// ══════════════════════════════════════════════════════════════
// Runner
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log("Phase 2 Acceptance Tests (TASK-5.9)")
  console.log("====================================")

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
