// tests/finn/action-policy-contract.test.ts — Cross-repo ActionPolicy contract tests (TASK-3.3b)
//
// Verifies that Beauvoir's serialized ActionPolicySpec is correctly consumed
// by Finn's enforcement layer. Self-contained: inlines all types/classes.

import assert from "node:assert/strict"

// ── Inline contract types (mirrors Beauvoir action-policy-spec.ts) ──

const ACTION_POLICY_SPEC_VERSION = 1

interface ConstraintSpec {
  draftOnly?: boolean
  labelsOnly?: string[]
  maxCommentLength?: number
  deniedEvents?: string[]
}

interface ActionPolicySpec {
  schemaVersion: number
  templateId: string
  allow: string[]
  deny: string[]
  constraints: Record<string, ConstraintSpec>
}

// ── Inline ActionPolicyDef + ActionPolicy (mirrors Beauvoir) ──

interface ActionPolicyDef {
  templateId: string
  allow: string[]
  deny: string[]
  constraints?: Record<string, ConstraintSpec>
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
  private readonly constraints: Record<string, ConstraintSpec>

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
    if (constraint.draftOnly) params.draft = true
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

// ── Inline toSpec / fromSpec (mirrors Beauvoir contract) ──

function toSpec(def: ActionPolicyDef): ActionPolicySpec {
  const constraints: Record<string, ConstraintSpec> = {}
  if (def.constraints) {
    for (const [tool, c] of Object.entries(def.constraints)) {
      const spec: ConstraintSpec = {}
      if (c.draftOnly !== undefined) spec.draftOnly = c.draftOnly
      if (c.labelsOnly !== undefined) spec.labelsOnly = [...c.labelsOnly]
      if (c.maxCommentLength !== undefined) spec.maxCommentLength = c.maxCommentLength
      if (c.deniedEvents !== undefined) spec.deniedEvents = [...c.deniedEvents]
      constraints[tool] = spec
    }
  }
  return {
    schemaVersion: ACTION_POLICY_SPEC_VERSION,
    templateId: def.templateId,
    allow: [...def.allow],
    deny: [...def.deny],
    constraints,
  }
}

function fromSpec(spec: ActionPolicySpec): ActionPolicy {
  if (spec.schemaVersion !== ACTION_POLICY_SPEC_VERSION) {
    throw new Error(
      `ActionPolicySpec version mismatch: expected ${ACTION_POLICY_SPEC_VERSION}, got ${spec.schemaVersion}`,
    )
  }
  return new ActionPolicy({
    templateId: spec.templateId,
    allow: spec.allow,
    deny: spec.deny,
    constraints: spec.constraints,
  })
}

// ── Test harness ──

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── PR Review template fixture (Beauvoir side) ──

const prReviewDef: ActionPolicyDef = {
  templateId: "pr-review",
  allow: ["get_pull_request", "get_file_contents", "create_pull_request_review", "add_issue_comment"],
  deny: ["merge_pull_request", "delete_branch"],
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

// ── 1. Round-trip serialization ──

test("toSpec produces valid ActionPolicySpec with correct schema version", () => {
  const spec = toSpec(prReviewDef)
  assert.equal(spec.schemaVersion, ACTION_POLICY_SPEC_VERSION)
  assert.equal(spec.templateId, "pr-review")
  assert.deepEqual(spec.allow, prReviewDef.allow)
  assert.deepEqual(spec.deny, prReviewDef.deny)
})

test("toSpec is JSON-serializable (no class instances)", () => {
  const spec = toSpec(prReviewDef)
  const json = JSON.stringify(spec)
  const parsed = JSON.parse(json) as ActionPolicySpec
  assert.deepEqual(parsed, spec)
})

test("toSpec deep-copies arrays (no shared references)", () => {
  const spec = toSpec(prReviewDef)
  spec.allow.push("extra_tool")
  assert.ok(!prReviewDef.allow.includes("extra_tool"))
})

// ── 2. fromSpec round-trip → enforcement ──

test("fromSpec round-trip: allowed tool passes", () => {
  const spec = toSpec(prReviewDef)
  const json = JSON.stringify(spec)
  const policy = fromSpec(JSON.parse(json) as ActionPolicySpec)
  assert.equal(policy.isAllowed("get_pull_request").allowed, true)
})

test("fromSpec round-trip: denied tool blocked", () => {
  const spec = toSpec(prReviewDef)
  const policy = fromSpec(spec)
  const result = policy.isAllowed("merge_pull_request")
  assert.equal(result.allowed, false)
  assert.ok(result.reason?.includes("explicitly denied"))
})

test("fromSpec round-trip: unlisted tool blocked", () => {
  const spec = toSpec(prReviewDef)
  const policy = fromSpec(spec)
  assert.equal(policy.isAllowed("create_branch").allowed, false)
})

// ── 3. APPROVE denial via contract (key acceptance criterion) ──

test("contract: APPROVE event denied for create_pull_request_review", () => {
  const spec = toSpec(prReviewDef)
  const policy = fromSpec(spec)
  const result = policy.isAllowed("create_pull_request_review", { event: "APPROVE" })
  assert.equal(result.allowed, false)
  assert.ok(result.reason?.includes("APPROVE"))
})

test("contract: COMMENT event allowed for create_pull_request_review", () => {
  const spec = toSpec(prReviewDef)
  const policy = fromSpec(spec)
  const result = policy.isAllowed("create_pull_request_review", { event: "COMMENT" })
  assert.equal(result.allowed, true)
})

// ── 4. Constraints survive serialization ──

test("contract: draftOnly constraint enforced after round-trip", () => {
  const spec = toSpec(prReviewDef)
  const policy = fromSpec(spec)
  const params: ToolParams = { draft: false, event: "COMMENT" }
  policy.applyConstraints("create_pull_request_review", params)
  assert.equal(params.draft, true)
})

test("contract: maxCommentLength constraint enforced after round-trip", () => {
  const spec = toSpec(prReviewDef)
  const policy = fromSpec(spec)
  const params: ToolParams = { commentBody: "x".repeat(1000) }
  policy.applyConstraints("add_issue_comment", params)
  assert.equal(params.commentBody?.length, 500)
})

// ── 5. Version mismatch (key acceptance criterion) ──

test("fromSpec rejects version mismatch with clear error", () => {
  const spec = toSpec(prReviewDef)
  spec.schemaVersion = 99
  assert.throws(
    () => fromSpec(spec),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.ok(err.message.includes("version mismatch"))
      assert.ok(err.message.includes("expected 1"))
      assert.ok(err.message.includes("got 99"))
      return true
    },
  )
})

test("fromSpec rejects version 0 (future-proofing)", () => {
  const spec = toSpec(prReviewDef)
  spec.schemaVersion = 0
  assert.throws(() => fromSpec(spec), /version mismatch/)
})

// ── Runner ──

async function main() {
  console.log("ActionPolicy Contract Tests (TASK-3.3b)")
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
