// tests/finn/pr-review-template.test.ts — PR Review template tests (TASK-3.1)

import assert from "node:assert/strict"
import { createHash } from "node:crypto"

// ── Inline types (mirrors Beauvoir base.ts + pr-review.ts) ──

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

// ── GitHub client types ──

interface PullRequest {
  number: number
  title: string
  headSha: string
  labels: string[]
  state: string
  mergeable_state?: string
  ci_status?: string
  reaction_counts?: Record<string, number>
  updated_at?: string
}

interface PullRequestFile {
  filename: string
  status: string
  additions: number
  deletions: number
  patch?: string
}

interface ReviewThread {
  id: number
  body: string
  user: string
  state: string
  submitted_at: string
}

interface GitHubClient {
  listPullRequests(state: "open" | "closed"): Promise<PullRequest[]>
  getPullRequestFiles(prNumber: number): Promise<PullRequestFile[]>
  getPullRequestReviews(prNumber: number): Promise<ReviewThread[]>
}

interface PrReviewConfig {
  reviewedLabel?: string
  dimensions?: string[]
}

// ── Inline PrReviewTemplate (mirrors Beauvoir pr-review.ts) ──

const PR_REVIEW_POLICY: ActionPolicyDef = {
  templateId: "pr-review",
  allow: [
    "get_pull_request",
    "get_pull_request_files",
    "get_pull_request_reviews",
    "get_pull_request_comments",
    "get_file_contents",
    "list_commits",
    "search_code",
    "create_pull_request_review",
  ],
  deny: [
    "merge_pull_request",
    "close_pull_request",
    "delete_branch",
    "update_pull_request_branch",
    "enable_auto_merge",
  ],
  constraints: {
    create_pull_request_review: {
      deniedEvents: ["APPROVE"],
    },
  },
}

const DEFAULT_REVIEW_DIMENSIONS = ["security", "quality", "test-coverage"]

class PrReviewTemplate extends BaseTemplate {
  readonly id = "pr-review"
  readonly name = "PR Review"
  readonly actionPolicy: ActionPolicyDef = PR_REVIEW_POLICY
  readonly canonicalHashFields = ["headSha", "files", "reviewThreads"]
  readonly excludedHashFields = [
    "mergeable_state",
    "ci_status",
    "reaction_counts",
    "updated_at",
  ]

  private readonly github: GitHubClient
  private readonly config: PrReviewConfig

  constructor(github: GitHubClient, config: PrReviewConfig = {}) {
    super()
    this.github = github
    this.config = config
  }

  async resolveItems(): Promise<TemplateItem[]> {
    const reviewedLabel = this.config.reviewedLabel ?? "agent-reviewed"
    const openPRs = await this.github.listPullRequests("open")
    const unreviewedPRs = openPRs.filter(
      pr => !pr.labels.includes(reviewedLabel),
    )

    const items: TemplateItem[] = []
    for (const pr of unreviewedPRs) {
      const files = await this.github.getPullRequestFiles(pr.number)
      const reviewThreads = await this.github.getPullRequestReviews(pr.number)

      const data: Record<string, unknown> = {
        number: pr.number,
        title: pr.title,
        headSha: pr.headSha,
        files: files.map(f => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
        })),
        reviewThreads: reviewThreads.map(r => ({
          id: r.id,
          body: r.body,
          user: r.user,
          state: r.state,
          submitted_at: r.submitted_at,
        })),
        mergeable_state: pr.mergeable_state,
        ci_status: pr.ci_status,
        reaction_counts: pr.reaction_counts,
        updated_at: pr.updated_at,
      }

      const item: TemplateItem = { key: `pr-${pr.number}`, hash: "", data }
      item.hash = this.computeStateHash(item)
      items.push(item)
    }

    return items
  }

  buildPrompt(item: TemplateItem): string {
    const dimensions = this.config.dimensions ?? [...DEFAULT_REVIEW_DIMENSIONS]
    const prNumber = item.data.number as number
    const prTitle = item.data.title as string
    const files = item.data.files as PullRequestFile[]
    const reviews = item.data.reviewThreads as ReviewThread[]

    const sections: string[] = []
    sections.push(`## PR #${prNumber}: ${prTitle}`)

    sections.push("\n### Review Dimensions")
    for (const dim of dimensions) {
      sections.push(`- **${dim}**: Evaluate this PR for ${dim} concerns.`)
    }

    sections.push("\n### Change Summary")
    if (files.length === 0) {
      sections.push("No files changed.")
    } else {
      const totalAdd = files.reduce((s, f) => s + f.additions, 0)
      const totalDel = files.reduce((s, f) => s + f.deletions, 0)
      sections.push(`${files.length} file(s) changed (+${totalAdd} -${totalDel})`)
      for (const f of files) {
        sections.push(`- \`${f.filename}\` (${f.status}, +${f.additions} -${f.deletions})`)
      }
    }

    sections.push("\n### Previous Review Context")
    if (reviews.length === 0) {
      sections.push("No previous reviews.")
    } else {
      for (const r of reviews) {
        sections.push(
          `- **${r.user}** (${r.state}, ${r.submitted_at}): ${r.body}`,
        )
      }
    }

    const lastReview = reviews.length > 0
      ? reviews.reduce((latest, r) =>
          r.submitted_at > latest.submitted_at ? r : latest,
        )
      : null

    sections.push("\n### Changes Since Last Review")
    if (!lastReview) {
      sections.push("This is the first review.")
    } else {
      sections.push(
        `Last review by **${lastReview.user}** at ${lastReview.submitted_at} (${lastReview.state}).`,
      )
      sections.push("Review all current changes against this baseline.")
    }

    return sections.join("\n")
  }
}

// ── Mock GitHub client factory ──

function createMockClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listPullRequests: overrides.listPullRequests ?? (async () => []),
    getPullRequestFiles: overrides.getPullRequestFiles ?? (async () => []),
    getPullRequestReviews: overrides.getPullRequestReviews ?? (async () => []),
  }
}

// ── Test harness ──

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Fixtures ──

const mockFiles: PullRequestFile[] = [
  { filename: "src/index.ts", status: "modified", additions: 10, deletions: 3, patch: "@@ ..." },
  { filename: "tests/index.test.ts", status: "added", additions: 25, deletions: 0 },
]

const mockReviews: ReviewThread[] = [
  { id: 1, body: "Looks good but needs tests", user: "alice", state: "CHANGES_REQUESTED", submitted_at: "2026-01-15T10:00:00Z" },
  { id: 2, body: "Tests added, LGTM", user: "bob", state: "COMMENTED", submitted_at: "2026-01-16T12:00:00Z" },
]

const mockPRs: PullRequest[] = [
  { number: 42, title: "Add feature X", headSha: "abc123", labels: [], state: "open" },
  { number: 43, title: "Fix bug Y", headSha: "def456", labels: ["agent-reviewed"], state: "open" },
  { number: 44, title: "Refactor Z", headSha: "ghi789", labels: ["needs-review"], state: "open" },
]

// ── 1. Hash computation stability ──

test("hash is deterministic for same canonical data", async () => {
  const client = createMockClient({
    listPullRequests: async () => [mockPRs[0]],
    getPullRequestFiles: async () => mockFiles,
    getPullRequestReviews: async () => mockReviews,
  })
  const tmpl = new PrReviewTemplate(client)

  const items1 = await tmpl.resolveItems()
  const items2 = await tmpl.resolveItems()

  assert.equal(items1[0].hash, items2[0].hash)
  assert.equal(items1[0].hash.length, 64) // SHA-256 hex
})

test("hash changes when headSha changes", async () => {
  const pr1: PullRequest = { number: 42, title: "A", headSha: "sha-v1", labels: [], state: "open" }
  const pr2: PullRequest = { number: 42, title: "A", headSha: "sha-v2", labels: [], state: "open" }

  const tmpl1 = new PrReviewTemplate(createMockClient({
    listPullRequests: async () => [pr1],
    getPullRequestFiles: async () => mockFiles,
    getPullRequestReviews: async () => [],
  }))
  const tmpl2 = new PrReviewTemplate(createMockClient({
    listPullRequests: async () => [pr2],
    getPullRequestFiles: async () => mockFiles,
    getPullRequestReviews: async () => [],
  }))

  const items1 = await tmpl1.resolveItems()
  const items2 = await tmpl2.resolveItems()

  assert.notEqual(items1[0].hash, items2[0].hash)
})

test("hash ignores excluded volatile fields", async () => {
  const pr1: PullRequest = { number: 1, title: "T", headSha: "aaa", labels: [], state: "open", mergeable_state: "clean", ci_status: "success", updated_at: "2026-01-01" }
  const pr2: PullRequest = { number: 1, title: "T", headSha: "aaa", labels: [], state: "open", mergeable_state: "unstable", ci_status: "failing", updated_at: "2026-02-01" }

  const client1 = createMockClient({ listPullRequests: async () => [pr1], getPullRequestFiles: async () => [], getPullRequestReviews: async () => [] })
  const client2 = createMockClient({ listPullRequests: async () => [pr2], getPullRequestFiles: async () => [], getPullRequestReviews: async () => [] })

  const items1 = await new PrReviewTemplate(client1).resolveItems()
  const items2 = await new PrReviewTemplate(client2).resolveItems()

  assert.equal(items1[0].hash, items2[0].hash)
})

test("hash changes when files change", async () => {
  const pr: PullRequest = { number: 1, title: "T", headSha: "same", labels: [], state: "open" }
  const filesA: PullRequestFile[] = [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0 }]
  const filesB: PullRequestFile[] = [{ filename: "b.ts", status: "added", additions: 5, deletions: 0 }]

  const tmplA = new PrReviewTemplate(createMockClient({ listPullRequests: async () => [pr], getPullRequestFiles: async () => filesA, getPullRequestReviews: async () => [] }))
  const tmplB = new PrReviewTemplate(createMockClient({ listPullRequests: async () => [pr], getPullRequestFiles: async () => filesB, getPullRequestReviews: async () => [] }))

  const itemsA = await tmplA.resolveItems()
  const itemsB = await tmplB.resolveItems()

  assert.notEqual(itemsA[0].hash, itemsB[0].hash)
})

test("hash changes when reviewThreads change", async () => {
  const pr: PullRequest = { number: 1, title: "T", headSha: "same", labels: [], state: "open" }
  const reviewsA: ReviewThread[] = []
  const reviewsB: ReviewThread[] = [{ id: 1, body: "Fix this", user: "alice", state: "CHANGES_REQUESTED", submitted_at: "2026-01-15T10:00:00Z" }]

  const tmplA = new PrReviewTemplate(createMockClient({ listPullRequests: async () => [pr], getPullRequestFiles: async () => [], getPullRequestReviews: async () => reviewsA }))
  const tmplB = new PrReviewTemplate(createMockClient({ listPullRequests: async () => [pr], getPullRequestFiles: async () => [], getPullRequestReviews: async () => reviewsB }))

  const itemsA = await tmplA.resolveItems()
  const itemsB = await tmplB.resolveItems()

  assert.notEqual(itemsA[0].hash, itemsB[0].hash)
})

// ── 2. resolveItems filters by label ──

test("resolveItems filters out PRs with agent-reviewed label", async () => {
  const client = createMockClient({
    listPullRequests: async () => mockPRs,
    getPullRequestFiles: async () => [],
    getPullRequestReviews: async () => [],
  })
  const tmpl = new PrReviewTemplate(client)
  const items = await tmpl.resolveItems()

  // PR#43 has "agent-reviewed" label, so only PR#42 and PR#44 should remain
  assert.equal(items.length, 2)
  assert.equal(items[0].key, "pr-42")
  assert.equal(items[1].key, "pr-44")
})

test("resolveItems uses custom reviewedLabel from config", async () => {
  const prs: PullRequest[] = [
    { number: 10, title: "A", headSha: "a", labels: ["bot-reviewed"], state: "open" },
    { number: 11, title: "B", headSha: "b", labels: [], state: "open" },
  ]
  const client = createMockClient({
    listPullRequests: async () => prs,
    getPullRequestFiles: async () => [],
    getPullRequestReviews: async () => [],
  })
  const tmpl = new PrReviewTemplate(client, { reviewedLabel: "bot-reviewed" })
  const items = await tmpl.resolveItems()

  assert.equal(items.length, 1)
  assert.equal(items[0].key, "pr-11")
})

// ── 3. buildPrompt includes previous context ──

test("buildPrompt includes previous review context", () => {
  const tmpl = new PrReviewTemplate(createMockClient())
  const item: TemplateItem = {
    key: "pr-42",
    hash: "abc",
    data: {
      number: 42,
      title: "Add feature X",
      files: mockFiles,
      reviewThreads: mockReviews,
    },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("## PR #42: Add feature X"))
  assert.ok(prompt.includes("### Previous Review Context"))
  assert.ok(prompt.includes("alice"))
  assert.ok(prompt.includes("Looks good but needs tests"))
  assert.ok(prompt.includes("bob"))
  assert.ok(prompt.includes("Tests added, LGTM"))
})

test("buildPrompt shows 'No previous reviews' when none exist", () => {
  const tmpl = new PrReviewTemplate(createMockClient())
  const item: TemplateItem = {
    key: "pr-1",
    hash: "abc",
    data: { number: 1, title: "New PR", files: [], reviewThreads: [] },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("No previous reviews."))
  assert.ok(prompt.includes("This is the first review."))
})

// ── 4. buildPrompt change summary ──

test("buildPrompt includes change summary with file stats", () => {
  const tmpl = new PrReviewTemplate(createMockClient())
  const item: TemplateItem = {
    key: "pr-42",
    hash: "abc",
    data: { number: 42, title: "T", files: mockFiles, reviewThreads: [] },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("### Change Summary"))
  assert.ok(prompt.includes("2 file(s) changed (+35 -3)"))
  assert.ok(prompt.includes("`src/index.ts`"))
  assert.ok(prompt.includes("`tests/index.test.ts`"))
})

test("buildPrompt shows 'No files changed' for empty file list", () => {
  const tmpl = new PrReviewTemplate(createMockClient())
  const item: TemplateItem = {
    key: "pr-1",
    hash: "abc",
    data: { number: 1, title: "T", files: [], reviewThreads: [] },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("No files changed."))
})

// ── 5. buildPrompt review dimensions ──

test("buildPrompt includes default review dimensions", () => {
  const tmpl = new PrReviewTemplate(createMockClient())
  const item: TemplateItem = {
    key: "pr-1",
    hash: "abc",
    data: { number: 1, title: "T", files: [], reviewThreads: [] },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("### Review Dimensions"))
  assert.ok(prompt.includes("**security**"))
  assert.ok(prompt.includes("**quality**"))
  assert.ok(prompt.includes("**test-coverage**"))
})

test("buildPrompt uses custom dimensions from config", () => {
  const tmpl = new PrReviewTemplate(createMockClient(), {
    dimensions: ["performance", "accessibility"],
  })
  const item: TemplateItem = {
    key: "pr-1",
    hash: "abc",
    data: { number: 1, title: "T", files: [], reviewThreads: [] },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("**performance**"))
  assert.ok(prompt.includes("**accessibility**"))
  assert.ok(!prompt.includes("**security**"))
})

// ── 6. Changes since last review ──

test("buildPrompt shows changes since last review with latest reviewer", () => {
  const tmpl = new PrReviewTemplate(createMockClient())
  const item: TemplateItem = {
    key: "pr-42",
    hash: "abc",
    data: {
      number: 42,
      title: "T",
      files: [],
      reviewThreads: mockReviews,
    },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("### Changes Since Last Review"))
  // bob's review is the latest (2026-01-16)
  assert.ok(prompt.includes("Last review by **bob**"))
  assert.ok(prompt.includes("2026-01-16T12:00:00Z"))
})

// ── 7. Action policy shape ──

test("action policy allows read tools and create_pull_request_review", () => {
  const tmpl = new PrReviewTemplate(createMockClient())
  const policy = tmpl.actionPolicy

  assert.ok(policy.allow.includes("get_pull_request"))
  assert.ok(policy.allow.includes("get_file_contents"))
  assert.ok(policy.allow.includes("create_pull_request_review"))
})

test("action policy denies merge/close/delete/update_branch/auto_merge", () => {
  const tmpl = new PrReviewTemplate(createMockClient())
  const policy = tmpl.actionPolicy

  assert.ok(policy.deny.includes("merge_pull_request"))
  assert.ok(policy.deny.includes("close_pull_request"))
  assert.ok(policy.deny.includes("delete_branch"))
  assert.ok(policy.deny.includes("update_pull_request_branch"))
  assert.ok(policy.deny.includes("enable_auto_merge"))
})

test("action policy constrains APPROVE event on create_pull_request_review", () => {
  const tmpl = new PrReviewTemplate(createMockClient())
  const constraint = tmpl.actionPolicy.constraints?.create_pull_request_review

  assert.ok(constraint)
  assert.ok(constraint!.deniedEvents?.includes("APPROVE"))
})

// ── Runner ──

async function main() {
  console.log("PR Review Template Tests (TASK-3.1)")
  console.log("====================================")
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
