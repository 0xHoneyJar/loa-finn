// tests/finn/stale-cleanup-template.test.ts — Stale Cleanup template tests (TASK-5.4)

import assert from "node:assert/strict"
import { createHash } from "node:crypto"

// -- Inline types (mirrors Beauvoir base.ts + stale-cleanup.ts) --

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

// -- GitHub client interface --

interface GitHubClient {
  listIssues(state: "open" | "closed"): Promise<Array<{ number: number; title: string; updated_at: string; pull_request?: unknown }>>
  listPullRequests(state: "open" | "closed"): Promise<Array<{ number: number; title: string; updated_at: string }>>
}

// -- Inline StaleCleanupTemplate (mirrors Beauvoir stale-cleanup.ts) --

const STALE_CLEANUP_POLICY: ActionPolicyDef = {
  templateId: "stale-cleanup",
  allow: ["list_issues", "list_pull_requests", "get_issue", "get_pull_request", "update_issue", "add_issue_comment"],
  deny: ["close_issue", "delete_branch", "merge_pull_request", "create_pull_request"],
  constraints: {
    update_issue: { labelsOnly: ["stale"] },
  },
}

class StaleCleanupTemplate extends BaseTemplate {
  readonly id = "stale-cleanup"
  readonly name = "Stale Cleanup"
  readonly actionPolicy: ActionPolicyDef = STALE_CLEANUP_POLICY
  readonly canonicalHashFields = ["updated_at"]
  readonly excludedHashFields = ["reactions", "assignee"]

  readonly schedule = "0 6 * * *"
  readonly defaultEnabled = false

  private readonly staleDays: number
  private readonly client: GitHubClient

  constructor(opts?: { staleDays?: number; client?: GitHubClient }) {
    super()
    this.staleDays = opts?.staleDays ?? 30
    this.client = opts?.client ?? { async listIssues() { return [] }, async listPullRequests() { return [] } }
  }

  async resolveItems(): Promise<TemplateItem[]> {
    const cutoff = Date.now() - this.staleDays * 86_400_000
    const [issues, prs] = await Promise.all([
      this.client.listIssues("open"),
      this.client.listPullRequests("open"),
    ])

    const items: TemplateItem[] = []

    for (const issue of issues) {
      if (issue.pull_request) continue
      if (new Date(issue.updated_at).getTime() < cutoff) {
        const data: Record<string, unknown> = { number: issue.number, title: issue.title, updated_at: issue.updated_at, kind: "issue" }
        const item: TemplateItem = { key: `issue-${issue.number}`, hash: "", data }
        item.hash = this.computeStateHash(item)
        items.push(item)
      }
    }

    for (const pr of prs) {
      if (new Date(pr.updated_at).getTime() < cutoff) {
        const data: Record<string, unknown> = { number: pr.number, title: pr.title, updated_at: pr.updated_at, kind: "pr" }
        const item: TemplateItem = { key: `pr-${pr.number}`, hash: "", data }
        item.hash = this.computeStateHash(item)
        items.push(item)
      }
    }

    return items
  }

  buildPrompt(item: TemplateItem): string {
    const number = item.data.number as number
    const title = item.data.title as string
    const updatedAt = item.data.updated_at as string
    const kind = item.data.kind as string
    const daysSince = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86_400_000)

    return [
      `## ${kind === "pr" ? "PR" : "Issue"} #${number}: ${title}`,
      "",
      `This ${kind} has had no activity for ${daysSince} days (last updated: ${updatedAt}).`,
      "",
      `Add the **stale** label and post a comment notifying contributors of the inactivity.`,
    ].join("\n")
  }
}

// -- Test harness --

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// -- Fixtures --

const NOW = Date.now()
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

const staleIssue = { number: 10, title: "Old bug", updated_at: daysAgo(45) }
const recentIssue = { number: 11, title: "Fresh bug", updated_at: daysAgo(5) }
const stalePR = { number: 20, title: "Old PR", updated_at: daysAgo(60) }
const recentPR = { number: 21, title: "Fresh PR", updated_at: daysAgo(2) }

function createMockClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listIssues: overrides.listIssues ?? (async () => []),
    listPullRequests: overrides.listPullRequests ?? (async () => []),
  }
}

// -- 1. resolveItems: returns items older than staleDays --

test("resolveItems: returns items older than staleDays", async () => {
  const client = createMockClient({
    listIssues: async () => [staleIssue, recentIssue],
    listPullRequests: async () => [stalePR, recentPR],
  })
  const tmpl = new StaleCleanupTemplate({ client })
  const items = await tmpl.resolveItems()

  assert.equal(items.length, 2)
  assert.equal(items[0].key, "issue-10")
  assert.equal(items[1].key, "pr-20")
})

// -- 2. resolveItems: excludes recent items --

test("resolveItems: excludes recent items", async () => {
  const client = createMockClient({
    listIssues: async () => [recentIssue],
    listPullRequests: async () => [recentPR],
  })
  const tmpl = new StaleCleanupTemplate({ client })
  const items = await tmpl.resolveItems()

  assert.equal(items.length, 0)
})

// -- 3. computeStateHash: deterministic for same updated_at --

test("computeStateHash: deterministic for same updated_at", () => {
  const tmpl = new StaleCleanupTemplate()
  const item: TemplateItem = {
    key: "issue-10",
    hash: "",
    data: { number: 10, title: "Bug", updated_at: "2025-12-01T00:00:00Z", kind: "issue" },
  }
  const hash1 = tmpl.computeStateHash(item)
  const hash2 = tmpl.computeStateHash(item)

  assert.equal(hash1, hash2)
  assert.equal(hash1.length, 64) // SHA-256 hex
})

// -- 4. buildPrompt: explains inactivity duration --

test("buildPrompt: explains inactivity duration", () => {
  const tmpl = new StaleCleanupTemplate()
  const item: TemplateItem = {
    key: "issue-10",
    hash: "abc",
    data: { number: 10, title: "Old bug", updated_at: daysAgo(45), kind: "issue" },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("no activity for"))
  assert.ok(prompt.includes("45 days"))
  assert.ok(prompt.includes("Issue #10: Old bug"))
})

// -- 5. buildPrompt: mentions stale label --

test("buildPrompt: mentions stale label", () => {
  const tmpl = new StaleCleanupTemplate()
  const item: TemplateItem = {
    key: "pr-20",
    hash: "abc",
    data: { number: 20, title: "Old PR", updated_at: daysAgo(60), kind: "pr" },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("**stale** label"))
})

// -- 6. actionPolicy: allows update_issue and add_issue_comment --

test("actionPolicy: allows update_issue and add_issue_comment", () => {
  const tmpl = new StaleCleanupTemplate()
  const policy = tmpl.actionPolicy

  assert.ok(policy.allow.includes("update_issue"))
  assert.ok(policy.allow.includes("add_issue_comment"))
})

// -- 7. actionPolicy: denies close_issue --

test("actionPolicy: denies close_issue", () => {
  const tmpl = new StaleCleanupTemplate()
  const policy = tmpl.actionPolicy

  assert.ok(policy.deny.includes("close_issue"))
})

// -- 8. actionPolicy: labelsOnly constraint limits to stale --

test("actionPolicy: labelsOnly constraint limits to stale", () => {
  const tmpl = new StaleCleanupTemplate()
  const constraint = tmpl.actionPolicy.constraints?.update_issue

  assert.ok(constraint)
  assert.deepEqual(constraint!.labelsOnly, ["stale"])
})

// -- 9. defaults: staleDays is 30 --

test("defaults: staleDays is 30", async () => {
  // An issue updated 25 days ago should NOT appear (within 30-day window)
  // An issue updated 35 days ago SHOULD appear (beyond 30-day window)
  const borderIssue = { number: 50, title: "Border", updated_at: daysAgo(25) }
  const staleEnough = { number: 51, title: "Stale enough", updated_at: daysAgo(35) }
  const client = createMockClient({
    listIssues: async () => [borderIssue, staleEnough],
    listPullRequests: async () => [],
  })
  const tmpl = new StaleCleanupTemplate({ client })
  const items = await tmpl.resolveItems()

  assert.equal(items.length, 1)
  assert.equal(items[0].key, "issue-51")
})

// -- 10. defaults: disabled by default --

test("defaults: disabled by default", () => {
  const tmpl = new StaleCleanupTemplate()
  assert.equal(tmpl.defaultEnabled, false)
})

// -- Runner --

async function main() {
  console.log("Stale Cleanup Template Tests (TASK-5.4)")
  console.log("========================================")
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
