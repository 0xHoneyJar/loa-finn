// tests/finn/issue-triage-template.test.ts — Issue Triage template tests (TASK-5.1)

import assert from "node:assert/strict"
import { createHash } from "node:crypto"

// ── Inline types (mirrors Beauvoir base.ts + issue-triage.ts) ──

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
  commentCount: number
  updated_at?: string
  reactions?: Record<string, number>
  assignee?: string | null
  milestone?: string | null
}

interface IssueClient {
  listIssues(opts: { state: "open" | "closed" }): Promise<Issue[]>
  getIssue(opts: { number: number }): Promise<Issue>
}

// ── Inline IssueTriageTemplate (mirrors Beauvoir issue-triage.ts) ──

const ISSUE_TRIAGE_POLICY: ActionPolicyDef = {
  templateId: "issue-triage",
  allow: [
    "list_issues",
    "get_issue",
    "search_issues",
    "update_issue",
    "add_issue_comment",
  ],
  deny: [
    "close_issue",
    "delete_issue",
    "merge_pull_request",
    "create_pull_request",
  ],
  constraints: {
    update_issue: {
      labelsOnly: [
        "bug",
        "enhancement",
        "question",
        "docs",
        "invalid",
        "P0",
        "P1",
        "P2",
        "P3",
        "triaged",
      ],
    },
  },
}

class IssueTriageTemplate extends BaseTemplate {
  readonly id = "issue-triage"
  readonly name = "Issue Triage"
  readonly actionPolicy: ActionPolicyDef = ISSUE_TRIAGE_POLICY
  readonly canonicalHashFields = ["title", "body", "labels", "commentCount"]
  readonly excludedHashFields = ["updated_at", "reactions", "assignee", "milestone"]

  readonly schedule = "*/15 * * * *"

  private readonly client: IssueClient

  constructor(client: IssueClient) {
    super()
    this.client = client
  }

  async resolveItems(): Promise<TemplateItem[]> {
    const openIssues = await this.client.listIssues({ state: "open" })
    const untriagedIssues = openIssues.filter(
      issue => !issue.labels.includes("triaged"),
    )

    const items: TemplateItem[] = []
    for (const issue of untriagedIssues) {
      const data: Record<string, unknown> = {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        commentCount: issue.commentCount,
        updated_at: issue.updated_at,
        reactions: issue.reactions,
        assignee: issue.assignee,
        milestone: issue.milestone,
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

    sections.push("\n### Classification")
    sections.push("Classify this issue into one of the following types:")
    sections.push("- **bug**: Something is broken or not working as expected.")
    sections.push("- **enhancement**: A new feature request or improvement.")
    sections.push("- **question**: A question about usage or behavior.")
    sections.push("- **docs**: Documentation improvement or correction.")
    sections.push("- **invalid**: Not a valid issue (spam, duplicate, out of scope).")

    sections.push("\n### Priority Assessment")
    sections.push("Assess the priority of this issue:")
    sections.push("- **P0**: Critical — system down, data loss, security vulnerability.")
    sections.push("- **P1**: High — major feature broken, significant user impact.")
    sections.push("- **P2**: Medium — minor feature issue, workaround available.")
    sections.push("- **P3**: Low — cosmetic, nice-to-have, minor improvement.")

    sections.push("\n### Label Suggestions")
    sections.push("Suggest appropriate labels based on the classification and priority above.")
    if (labels.length > 0) {
      sections.push(`Current labels: ${labels.join(", ")}`)
    } else {
      sections.push("No labels currently assigned.")
    }

    sections.push("\n### Issue Body")
    if (issueBody) {
      sections.push(issueBody)
    } else {
      sections.push("(No body provided.)")
    }

    return sections.join("\n")
  }
}

// ── Mock client factory ──

function createMockClient(overrides: Partial<IssueClient> = {}): IssueClient {
  return {
    listIssues: overrides.listIssues ?? (async () => []),
    getIssue: overrides.getIssue ?? (async () => ({
      number: 0, title: "", body: "", labels: [], state: "open", commentCount: 0,
    })),
  }
}

// ── Test harness ──

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Fixtures ──

const mockIssues: Issue[] = [
  { number: 10, title: "App crashes on startup", body: "The app crashes when I click run.", labels: ["bug"], state: "open", commentCount: 3 },
  { number: 11, title: "Add dark mode", body: "Please add dark mode support.", labels: ["triaged", "enhancement"], state: "open", commentCount: 1 },
  { number: 12, title: "How do I configure X?", body: "I cannot find the config docs.", labels: [], state: "open", commentCount: 0 },
]

// ── 1. resolveItems: filters out issues with triaged label ──

test("resolveItems: filters out issues with triaged label", async () => {
  const client = createMockClient({
    listIssues: async () => mockIssues,
  })
  const tmpl = new IssueTriageTemplate(client)
  const items = await tmpl.resolveItems()

  // Issue #11 has "triaged" label, should be excluded
  const keys = items.map(i => i.key)
  assert.ok(!keys.includes("issue-11"), "issue-11 should be filtered out")
})

// ── 2. resolveItems: returns issues without triaged label ──

test("resolveItems: returns issues without triaged label", async () => {
  const client = createMockClient({
    listIssues: async () => mockIssues,
  })
  const tmpl = new IssueTriageTemplate(client)
  const items = await tmpl.resolveItems()

  assert.equal(items.length, 2)
  assert.equal(items[0].key, "issue-10")
  assert.equal(items[1].key, "issue-12")
})

// ── 3. computeStateHash: deterministic for same inputs ──

test("computeStateHash: deterministic for same inputs", async () => {
  const client = createMockClient({
    listIssues: async () => [mockIssues[0]],
  })
  const tmpl = new IssueTriageTemplate(client)

  const items1 = await tmpl.resolveItems()
  const items2 = await tmpl.resolveItems()

  assert.equal(items1[0].hash, items2[0].hash)
  assert.equal(items1[0].hash.length, 64) // SHA-256 hex
})

// ── 4. computeStateHash: different for different titles ──

test("computeStateHash: different for different titles", async () => {
  const issueA: Issue = { number: 1, title: "Title A", body: "body", labels: [], state: "open", commentCount: 0 }
  const issueB: Issue = { number: 1, title: "Title B", body: "body", labels: [], state: "open", commentCount: 0 }

  const tmplA = new IssueTriageTemplate(createMockClient({ listIssues: async () => [issueA] }))
  const tmplB = new IssueTriageTemplate(createMockClient({ listIssues: async () => [issueB] }))

  const itemsA = await tmplA.resolveItems()
  const itemsB = await tmplB.resolveItems()

  assert.notEqual(itemsA[0].hash, itemsB[0].hash)
})

// ── 5. computeStateHash: ignores excluded fields (updated_at, reactions) ──

test("computeStateHash: ignores excluded fields (updated_at, reactions)", async () => {
  const issueA: Issue = {
    number: 1, title: "Same", body: "Same body", labels: ["bug"], state: "open", commentCount: 2,
    updated_at: "2026-01-01T00:00:00Z", reactions: { "+1": 5 }, assignee: "alice", milestone: "v1",
  }
  const issueB: Issue = {
    number: 1, title: "Same", body: "Same body", labels: ["bug"], state: "open", commentCount: 2,
    updated_at: "2026-02-15T12:00:00Z", reactions: { "-1": 3 }, assignee: "bob", milestone: "v2",
  }

  const tmplA = new IssueTriageTemplate(createMockClient({ listIssues: async () => [issueA] }))
  const tmplB = new IssueTriageTemplate(createMockClient({ listIssues: async () => [issueB] }))

  const itemsA = await tmplA.resolveItems()
  const itemsB = await tmplB.resolveItems()

  assert.equal(itemsA[0].hash, itemsB[0].hash)
})

// ── 6. buildPrompt: contains classification instructions ──

test("buildPrompt: contains classification instructions", () => {
  const tmpl = new IssueTriageTemplate(createMockClient())
  const item: TemplateItem = {
    key: "issue-10",
    hash: "abc",
    data: { number: 10, title: "Crash", body: "It crashes.", labels: [], commentCount: 0 },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("### Classification"))
  assert.ok(prompt.includes("**bug**"))
  assert.ok(prompt.includes("**enhancement**"))
  assert.ok(prompt.includes("**question**"))
  assert.ok(prompt.includes("**docs**"))
  assert.ok(prompt.includes("**invalid**"))
})

// ── 7. buildPrompt: includes issue title and body ──

test("buildPrompt: includes issue title and body", () => {
  const tmpl = new IssueTriageTemplate(createMockClient())
  const item: TemplateItem = {
    key: "issue-10",
    hash: "abc",
    data: { number: 10, title: "App crashes on startup", body: "The app crashes when I click run.", labels: [], commentCount: 0 },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("## Issue #10: App crashes on startup"))
  assert.ok(prompt.includes("The app crashes when I click run."))
})

// ── 8. buildPrompt: mentions priority assessment ──

test("buildPrompt: mentions priority assessment", () => {
  const tmpl = new IssueTriageTemplate(createMockClient())
  const item: TemplateItem = {
    key: "issue-10",
    hash: "abc",
    data: { number: 10, title: "Crash", body: "It crashes.", labels: [], commentCount: 0 },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("### Priority Assessment"))
  assert.ok(prompt.includes("**P0**"))
  assert.ok(prompt.includes("**P1**"))
  assert.ok(prompt.includes("**P2**"))
  assert.ok(prompt.includes("**P3**"))
})

// ── 9. actionPolicy: allows list_issues and get_issue ──

test("actionPolicy: allows list_issues and get_issue", () => {
  const tmpl = new IssueTriageTemplate(createMockClient())
  const policy = tmpl.actionPolicy

  assert.ok(policy.allow.includes("list_issues"))
  assert.ok(policy.allow.includes("get_issue"))
  assert.ok(policy.allow.includes("search_issues"))
  assert.ok(policy.allow.includes("update_issue"))
  assert.ok(policy.allow.includes("add_issue_comment"))
})

// ── 10. actionPolicy: denies merge_pull_request ──

test("actionPolicy: denies merge_pull_request", () => {
  const tmpl = new IssueTriageTemplate(createMockClient())
  const policy = tmpl.actionPolicy

  assert.ok(policy.deny.includes("merge_pull_request"))
  assert.ok(policy.deny.includes("close_issue"))
  assert.ok(policy.deny.includes("delete_issue"))
  assert.ok(policy.deny.includes("create_pull_request"))
})

// ── 11. actionPolicy: labelsOnly constraint on update_issue ──

test("actionPolicy: labelsOnly constraint on update_issue", () => {
  const tmpl = new IssueTriageTemplate(createMockClient())
  const constraint = tmpl.actionPolicy.constraints?.update_issue

  assert.ok(constraint, "update_issue constraint should exist")
  assert.ok(constraint!.labelsOnly, "labelsOnly should be defined")
  assert.ok(constraint!.labelsOnly!.includes("bug"))
  assert.ok(constraint!.labelsOnly!.includes("enhancement"))
  assert.ok(constraint!.labelsOnly!.includes("P0"))
  assert.ok(constraint!.labelsOnly!.includes("P3"))
  assert.ok(constraint!.labelsOnly!.includes("triaged"))
})

// ── Runner ──

async function main() {
  console.log("Issue Triage Template Tests (TASK-5.1)")
  console.log("=======================================")
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
