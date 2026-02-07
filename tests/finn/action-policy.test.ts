// tests/finn/action-policy.test.ts — Action Policy enforcement tests (TASK-3.3)

import assert from "node:assert/strict"

// ── Inline types (mirrors Beauvoir base.ts + action-policy.ts) ──

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

interface PolicyResult {
  allowed: boolean
  reason?: string
}

interface ToolParams {
  draft?: boolean
  labels?: string[]
  commentBody?: string
  event?: string
  [key: string]: unknown
}

class ActionPolicy {
  private readonly allow: Set<string>
  private readonly deny: Set<string>
  private readonly constraints: Record<string, ConstraintDef>

  constructor(def: ActionPolicyDef) {
    this.allow = new Set(def.allow)
    this.deny = new Set(def.deny)
    this.constraints = def.constraints ?? {}
  }

  isAllowed(toolName: string, params?: ToolParams): PolicyResult {
    if (this.deny.has(toolName)) {
      return { allowed: false, reason: `tool "${toolName}" is explicitly denied` }
    }
    if (!this.allow.has(toolName)) {
      return { allowed: false, reason: `tool "${toolName}" is not in the allow list` }
    }
    if (params?.event) {
      const constraint = this.constraints[toolName]
      if (constraint?.deniedEvents?.includes(params.event)) {
        return { allowed: false, reason: `event "${params.event}" is denied for tool "${toolName}"` }
      }
    }
    return { allowed: true }
  }

  applyConstraints(toolName: string, params: ToolParams): ToolParams {
    const constraint = this.constraints[toolName]
    if (!constraint) return params
    if (constraint.draftOnly) {
      params.draft = true
    }
    if (constraint.labelsOnly && params.labels) {
      params.labels = params.labels.filter(l => constraint.labelsOnly!.includes(l))
    }
    if (
      constraint.maxCommentLength != null &&
      params.commentBody != null &&
      params.commentBody.length > constraint.maxCommentLength
    ) {
      params.commentBody = params.commentBody.slice(0, constraint.maxCommentLength)
    }
    return params
  }
}

// ── Test harness ──

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── PR Review policy fixture ──

const prReviewDef: ActionPolicyDef = {
  templateId: "pr-review",
  allow: ["get_pull_request", "get_file_contents", "list_commits", "create_pull_request_review", "add_issue_comment"],
  deny: ["merge_pull_request", "delete_branch", "update_pull_request_branch"],
  constraints: {
    create_pull_request_review: {
      deniedEvents: ["APPROVE"],
      draftOnly: true,
    },
    add_issue_comment: {
      maxCommentLength: 500,
    },
  },
}

// ── 1. Allow/deny basics ──

test("allowed tool returns allowed: true", () => {
  const policy = new ActionPolicy(prReviewDef)
  const result = policy.isAllowed("get_pull_request")
  assert.equal(result.allowed, true)
  assert.equal(result.reason, undefined)
})

test("denied tool returns allowed: false", () => {
  const policy = new ActionPolicy(prReviewDef)
  const result = policy.isAllowed("merge_pull_request")
  assert.equal(result.allowed, false)
  assert.ok(result.reason?.includes("explicitly denied"))
})

test("unlisted tool returns allowed: false", () => {
  const policy = new ActionPolicy(prReviewDef)
  const result = policy.isAllowed("create_branch")
  assert.equal(result.allowed, false)
  assert.ok(result.reason?.includes("not in the allow list"))
})

// ── 2. Deny takes precedence over allow ──

test("deny wins when tool is in both allow and deny", () => {
  const def: ActionPolicyDef = {
    templateId: "test",
    allow: ["merge_pull_request", "get_pull_request"],
    deny: ["merge_pull_request"],
  }
  const policy = new ActionPolicy(def)
  const result = policy.isAllowed("merge_pull_request")
  assert.equal(result.allowed, false)
  assert.ok(result.reason?.includes("explicitly denied"))
})

// ── 3. deniedEvents constraint ──

test("deniedEvents: APPROVE event denied for create_pull_request_review", () => {
  const policy = new ActionPolicy(prReviewDef)
  const result = policy.isAllowed("create_pull_request_review", { event: "APPROVE" })
  assert.equal(result.allowed, false)
  assert.ok(result.reason?.includes("APPROVE"))
})

test("deniedEvents: COMMENT event allowed for create_pull_request_review", () => {
  const policy = new ActionPolicy(prReviewDef)
  const result = policy.isAllowed("create_pull_request_review", { event: "COMMENT" })
  assert.equal(result.allowed, true)
})

test("deniedEvents: REQUEST_CHANGES event allowed", () => {
  const policy = new ActionPolicy(prReviewDef)
  const result = policy.isAllowed("create_pull_request_review", { event: "REQUEST_CHANGES" })
  assert.equal(result.allowed, true)
})

// ── 4. Constraint: draftOnly ──

test("applyConstraints: draftOnly forces draft=true", () => {
  const policy = new ActionPolicy(prReviewDef)
  const params: ToolParams = { draft: false, event: "COMMENT" }
  policy.applyConstraints("create_pull_request_review", params)
  assert.equal(params.draft, true)
})

test("applyConstraints: draftOnly sets draft even if not present", () => {
  const policy = new ActionPolicy(prReviewDef)
  const params: ToolParams = { event: "COMMENT" }
  policy.applyConstraints("create_pull_request_review", params)
  assert.equal(params.draft, true)
})

// ── 5. Constraint: labelsOnly ──

test("applyConstraints: labelsOnly filters to allowed labels", () => {
  const def: ActionPolicyDef = {
    templateId: "test",
    allow: ["update_issue"],
    deny: [],
    constraints: {
      update_issue: { labelsOnly: ["bug", "enhancement"] },
    },
  }
  const policy = new ActionPolicy(def)
  const params: ToolParams = { labels: ["bug", "wontfix", "enhancement", "priority"] }
  policy.applyConstraints("update_issue", params)
  assert.deepEqual(params.labels, ["bug", "enhancement"])
})

// ── 6. Constraint: maxCommentLength ──

test("applyConstraints: maxCommentLength truncates long comments", () => {
  const policy = new ActionPolicy(prReviewDef)
  const longBody = "a".repeat(1000)
  const params: ToolParams = { commentBody: longBody }
  policy.applyConstraints("add_issue_comment", params)
  assert.equal(params.commentBody?.length, 500)
})

test("applyConstraints: maxCommentLength ignores short comments", () => {
  const policy = new ActionPolicy(prReviewDef)
  const params: ToolParams = { commentBody: "short" }
  policy.applyConstraints("add_issue_comment", params)
  assert.equal(params.commentBody, "short")
})

// ── 7. No constraints ──

test("applyConstraints: no-op for tool without constraints", () => {
  const policy = new ActionPolicy(prReviewDef)
  const params: ToolParams = { draft: false, labels: ["x"] }
  const result = policy.applyConstraints("get_pull_request", params)
  assert.equal(result.draft, false)
  assert.deepEqual(result.labels, ["x"])
})

// ── 8. Empty policy ──

test("empty allow list denies everything", () => {
  const policy = new ActionPolicy({ templateId: "empty", allow: [], deny: [] })
  assert.equal(policy.isAllowed("get_pull_request").allowed, false)
  assert.equal(policy.isAllowed("merge_pull_request").allowed, false)
})

// ── Runner ──

async function main() {
  console.log("Action Policy Tests (TASK-3.3)")
  console.log("==============================")
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
