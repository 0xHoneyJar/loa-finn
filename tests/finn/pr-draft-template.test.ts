// tests/finn/pr-draft-template.test.ts — PR Draft template tests (TASK-5.2)

import assert from "node:assert/strict"
import { createHash } from "node:crypto"

// ── Inline types (mirrors Beauvoir base.ts + pr-draft.ts) ──

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

// ── GitHub issue types ──

interface Issue {
  number: number
  title: string
  body: string
  labels: string[]
  state: string
  pull_request?: unknown
  updated_at?: string
  reactions?: Record<string, number>
  assignee?: string | null
}

interface PrDraftClient {
  listIssues(opts: { state: "open" | "closed"; labels?: string }): Promise<Issue[]>
  getIssue(opts: { number: number }): Promise<Issue>
  searchIssues(query: string): Promise<Issue[]>
}

interface PrDraftConfig {
  maxDiffLines?: number
  maxFilesChanged?: number
  branchPrefix?: string
}

// ── Inline PrDraftTemplate (mirrors Beauvoir pr-draft.ts) ──

const PR_DRAFT_POLICY: ActionPolicyDef = {
  templateId: "pr-draft",
  allow: [
    "list_issues",
    "get_issue",
    "search_issues",
    "get_file_contents",
    "list_commits",
    "create_branch",
    "create_or_update_file",
    "push_files",
    "create_pull_request",
    "add_issue_comment",
  ],
  deny: [
    "merge_pull_request",
    "delete_branch",
    "update_pull_request_branch",
  ],
  constraints: {
    create_pull_request: { draftOnly: true },
    create_or_update_file: {},
  },
}

class PrDraftTemplate extends BaseTemplate {
  readonly id = "pr-draft"
  readonly name = "PR Draft"
  readonly actionPolicy: ActionPolicyDef = PR_DRAFT_POLICY
  readonly canonicalHashFields = ["title", "body", "labels"]
  readonly excludedHashFields = ["updated_at", "reactions", "assignee"]

  private readonly client: PrDraftClient
  private readonly config: Required<PrDraftConfig>

  constructor(client: PrDraftClient, config?: PrDraftConfig) {
    super()
    this.client = client
    this.config = {
      maxDiffLines: config?.maxDiffLines ?? 500,
      maxFilesChanged: config?.maxFilesChanged ?? 20,
      branchPrefix: config?.branchPrefix ?? "agent",
    }
  }

  async resolveItems(): Promise<TemplateItem[]> {
    const openIssues = await this.client.listIssues({ state: "open" })
    const readyIssues = openIssues.filter(
      issue => issue.labels.includes("ready-for-pr") && !issue.pull_request,
    )

    const items: TemplateItem[] = []
    for (const issue of readyIssues) {
      const data: Record<string, unknown> = {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        updated_at: issue.updated_at,
        reactions: issue.reactions,
        assignee: issue.assignee,
      }

      const item: TemplateItem = { key: `issue-${issue.number}`, hash: "", data }
      item.hash = this.computeStateHash(item)
      items.push(item)
    }

    return items
  }

  buildPrompt(item: TemplateItem): string {
    const issueNumber = item.data.number as number
    const issueTitle = item.data.title as string
    const issueBody = item.data.body as string
    const labels = item.data.labels as string[]

    const sections: string[] = []

    sections.push(`## Issue #${issueNumber}: ${issueTitle}`)

    sections.push("\n### Issue Context")
    if (labels.length > 0) {
      sections.push(`Labels: ${labels.join(", ")}`)
    }
    if (issueBody) {
      sections.push(issueBody)
    } else {
      sections.push("(No body provided.)")
    }

    sections.push("\n### Implementation Instructions")
    sections.push("Create a draft pull request that addresses this issue.")
    sections.push("Follow the repository's coding standards and conventions.")
    sections.push("Include tests for any new functionality.")

    sections.push("\n### MVP Constraints")
    sections.push(`- Maximum diff lines: ${this.config.maxDiffLines}`)
    sections.push(`- Maximum files changed: ${this.config.maxFilesChanged}`)
    sections.push("- PR must be created as a **draft** (not ready for review).")
    sections.push("- Keep changes minimal and focused on the issue.")

    return sections.join("\n")
  }

  buildBranchName(jobId: string, issueNumber: number): string {
    return `${this.config.branchPrefix}/${jobId}/${issueNumber}`
  }

  checkMvpConstraints(
    diffLines: number,
    filesChanged: number,
  ): { pass: boolean; violations: string[] } {
    const violations: string[] = []

    if (diffLines > this.config.maxDiffLines) {
      violations.push(
        `Diff lines ${diffLines} exceeds maximum ${this.config.maxDiffLines}`,
      )
    }

    if (filesChanged > this.config.maxFilesChanged) {
      violations.push(
        `Files changed ${filesChanged} exceeds maximum ${this.config.maxFilesChanged}`,
      )
    }

    return { pass: violations.length === 0, violations }
  }
}

// ── Mock client factory ──

function createMockClient(overrides: Partial<PrDraftClient> = {}): PrDraftClient {
  return {
    listIssues: overrides.listIssues ?? (async () => []),
    getIssue: overrides.getIssue ?? (async () => ({
      number: 0, title: "", body: "", labels: [], state: "open",
    })),
    searchIssues: overrides.searchIssues ?? (async () => []),
  }
}

// ── Test harness ──

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Fixtures ──

const mockIssues: Issue[] = [
  { number: 10, title: "Add caching layer", body: "We need a caching layer for API responses.", labels: ["ready-for-pr", "enhancement"], state: "open" },
  { number: 11, title: "Fix login bug", body: "Login fails on mobile.", labels: ["bug"], state: "open" },
  { number: 12, title: "Refactor auth module", body: "Auth module needs cleanup.", labels: ["ready-for-pr"], state: "open" },
  { number: 13, title: "Already has PR", body: "This issue has a linked PR.", labels: ["ready-for-pr"], state: "open", pull_request: { url: "https://api.github.com/pulls/99" } },
]

// ── 1. resolveItems: returns issues with ready-for-pr label ──

test("resolveItems: returns issues with ready-for-pr label", async () => {
  const client = createMockClient({
    listIssues: async () => mockIssues,
  })
  const tmpl = new PrDraftTemplate(client)
  const items = await tmpl.resolveItems()

  const keys = items.map(i => i.key)
  assert.ok(keys.includes("issue-10"), "issue-10 should be included (has ready-for-pr)")
  assert.ok(keys.includes("issue-12"), "issue-12 should be included (has ready-for-pr)")
})

// ── 2. resolveItems: excludes issues without ready-for-pr label ──

test("resolveItems: excludes issues without ready-for-pr label", async () => {
  const client = createMockClient({
    listIssues: async () => mockIssues,
  })
  const tmpl = new PrDraftTemplate(client)
  const items = await tmpl.resolveItems()

  const keys = items.map(i => i.key)
  assert.ok(!keys.includes("issue-11"), "issue-11 should be excluded (no ready-for-pr label)")
})

// ── 3. resolveItems: excludes issues with linked PR ──

test("resolveItems: excludes issues with linked PR", async () => {
  const client = createMockClient({
    listIssues: async () => mockIssues,
  })
  const tmpl = new PrDraftTemplate(client)
  const items = await tmpl.resolveItems()

  const keys = items.map(i => i.key)
  assert.ok(!keys.includes("issue-13"), "issue-13 should be excluded (has linked PR)")
})

// ── 4. buildBranchName: correct format agent/{jobId}/{issueNumber} ──

test("buildBranchName: correct format agent/{jobId}/{issueNumber}", () => {
  const tmpl = new PrDraftTemplate(createMockClient())
  const branch = tmpl.buildBranchName("job-abc", 42)

  assert.equal(branch, "agent/job-abc/42")
})

// ── 5. checkMvpConstraints: passes within limits ──

test("checkMvpConstraints: passes within limits", () => {
  const tmpl = new PrDraftTemplate(createMockClient())
  const result = tmpl.checkMvpConstraints(100, 5)

  assert.equal(result.pass, true)
  assert.equal(result.violations.length, 0)
})

// ── 6. checkMvpConstraints: fails on too many diff lines ──

test("checkMvpConstraints: fails on too many diff lines", () => {
  const tmpl = new PrDraftTemplate(createMockClient())
  const result = tmpl.checkMvpConstraints(600, 5)

  assert.equal(result.pass, false)
  assert.equal(result.violations.length, 1)
  assert.ok(result.violations[0].includes("Diff lines"))
  assert.ok(result.violations[0].includes("600"))
})

// ── 7. checkMvpConstraints: fails on too many files ──

test("checkMvpConstraints: fails on too many files", () => {
  const tmpl = new PrDraftTemplate(createMockClient())
  const result = tmpl.checkMvpConstraints(100, 25)

  assert.equal(result.pass, false)
  assert.equal(result.violations.length, 1)
  assert.ok(result.violations[0].includes("Files changed"))
  assert.ok(result.violations[0].includes("25"))
})

// ── 8. actionPolicy: allows create_pull_request ──

test("actionPolicy: allows create_pull_request", () => {
  const tmpl = new PrDraftTemplate(createMockClient())
  const policy = tmpl.actionPolicy

  assert.ok(policy.allow.includes("create_pull_request"))
  assert.ok(policy.allow.includes("create_branch"))
  assert.ok(policy.allow.includes("push_files"))
})

// ── 9. actionPolicy: denies merge_pull_request ──

test("actionPolicy: denies merge_pull_request", () => {
  const tmpl = new PrDraftTemplate(createMockClient())
  const policy = tmpl.actionPolicy

  assert.ok(policy.deny.includes("merge_pull_request"))
  assert.ok(policy.deny.includes("delete_branch"))
  assert.ok(policy.deny.includes("update_pull_request_branch"))
})

// ── 10. actionPolicy: draftOnly constraint on create_pull_request ──

test("actionPolicy: draftOnly constraint on create_pull_request", () => {
  const tmpl = new PrDraftTemplate(createMockClient())
  const constraint = tmpl.actionPolicy.constraints?.create_pull_request

  assert.ok(constraint, "create_pull_request constraint should exist")
  assert.equal(constraint!.draftOnly, true, "draftOnly should be true")
})

// ── 11. buildPrompt: includes MVP constraints ──

test("buildPrompt: includes MVP constraints", () => {
  const tmpl = new PrDraftTemplate(createMockClient())
  const item: TemplateItem = {
    key: "issue-10",
    hash: "abc",
    data: { number: 10, title: "Add caching", body: "Need caching.", labels: ["ready-for-pr"], },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("### MVP Constraints"))
  assert.ok(prompt.includes("Maximum diff lines: 500"))
  assert.ok(prompt.includes("Maximum files changed: 20"))
  assert.ok(prompt.includes("**draft**"))
})

// ── 12. buildPrompt: includes issue context ──

test("buildPrompt: includes issue context", () => {
  const tmpl = new PrDraftTemplate(createMockClient())
  const item: TemplateItem = {
    key: "issue-10",
    hash: "abc",
    data: { number: 10, title: "Add caching layer", body: "We need a caching layer for API responses.", labels: ["ready-for-pr", "enhancement"] },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("## Issue #10: Add caching layer"))
  assert.ok(prompt.includes("### Issue Context"))
  assert.ok(prompt.includes("We need a caching layer for API responses."))
  assert.ok(prompt.includes("ready-for-pr"))
})

// ── 13. config defaults: maxDiffLines=500, maxFilesChanged=20 ──

test("config defaults: maxDiffLines=500, maxFilesChanged=20", () => {
  const tmpl = new PrDraftTemplate(createMockClient())

  // Verify defaults by checking constraint boundaries
  const atLimit = tmpl.checkMvpConstraints(500, 20)
  assert.equal(atLimit.pass, true, "Should pass at exactly the default limits")

  const overDiff = tmpl.checkMvpConstraints(501, 20)
  assert.equal(overDiff.pass, false, "Should fail at 501 diff lines")

  const overFiles = tmpl.checkMvpConstraints(500, 21)
  assert.equal(overFiles.pass, false, "Should fail at 21 files changed")
})

// ── Runner ──

async function main() {
  console.log("PR Draft Template Tests (TASK-5.2)")
  console.log("===================================")
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
