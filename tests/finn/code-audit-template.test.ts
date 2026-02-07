// tests/finn/code-audit-template.test.ts — Code Audit template tests (TASK-5.3)

import assert from "node:assert/strict"
import { createHash } from "node:crypto"

// ── Inline types (mirrors Beauvoir base.ts + code-audit.ts) ──

interface ActionPolicyDef {
  templateId: string
  allow: string[]
  deny: string[]
  constraints?: Record<string, unknown>
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

// ── Inline CodeAuditTemplate (mirrors Beauvoir code-audit.ts) ──

interface CodeAuditClient {
  getHeadSha(opts: { ref?: string }): Promise<string>
}

const CODE_AUDIT_POLICY: ActionPolicyDef = {
  templateId: "code-audit",
  allow: ["get_file_contents", "search_code", "list_commits", "create_issue"],
  deny: [
    "merge_pull_request",
    "delete_branch",
    "update_issue",
    "create_pull_request",
    "add_issue_comment",
  ],
  constraints: {},
}

class CodeAuditTemplate extends BaseTemplate {
  readonly id = "code-audit"
  readonly name = "Code Audit"
  readonly actionPolicy: ActionPolicyDef = CODE_AUDIT_POLICY
  readonly canonicalHashFields = ["headSha"]
  readonly excludedHashFields = ["updated_at", "ci_status"]
  readonly schedule = "0 3 * * *"

  private readonly client: CodeAuditClient

  constructor(client: CodeAuditClient) {
    super()
    this.client = client
  }

  async resolveItems(): Promise<TemplateItem[]> {
    const headSha = await this.client.getHeadSha({ ref: "HEAD" })
    const data: Record<string, unknown> = { headSha }
    const item: TemplateItem = { key: "repo-head", hash: "", data }
    item.hash = this.computeStateHash(item)
    return [item]
  }

  buildPrompt(item: TemplateItem): string {
    const headSha = item.data.headSha as string
    const sections: string[] = []
    sections.push(`## Code Audit — HEAD ${headSha}`)
    sections.push("\n### Security Review")
    sections.push(
      "Perform a security audit of the codebase against the OWASP Top 10 vulnerability categories:",
    )
    sections.push("- Injection flaws (SQL, NoSQL, OS command, LDAP)")
    sections.push("- Broken authentication and session management")
    sections.push("- Sensitive data exposure")
    sections.push("- Security misconfiguration")
    sections.push("- Cross-site scripting (XSS)")
    sections.push("\n### Code Quality")
    sections.push("Evaluate the codebase for:")
    sections.push("- Dead code and unused imports")
    sections.push("- Error handling gaps")
    sections.push("- Dependency vulnerabilities")
    sections.push("- Type safety concerns")
    sections.push("\n### Output")
    sections.push(
      "Create a GitHub issue summarising all findings, categorised by severity (critical, high, medium, low).",
    )
    return sections.join("\n")
  }
}

// ── Test harness ──

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Tests ──

test("resolveItems: returns single item with headSha", async () => {
  const client: CodeAuditClient = { getHeadSha: async () => "abc123def456" }
  const tmpl = new CodeAuditTemplate(client)
  const items = await tmpl.resolveItems()

  assert.equal(items.length, 1)
  assert.equal(items[0].key, "repo-head")
  assert.equal(items[0].data.headSha, "abc123def456")
  assert.equal(items[0].hash.length, 64)
})

test("computeStateHash: deterministic for same headSha", async () => {
  const client: CodeAuditClient = { getHeadSha: async () => "same-sha" }
  const tmpl = new CodeAuditTemplate(client)

  const items1 = await tmpl.resolveItems()
  const items2 = await tmpl.resolveItems()

  assert.equal(items1[0].hash, items2[0].hash)
})

test("computeStateHash: different for different headSha", async () => {
  const tmpl1 = new CodeAuditTemplate({ getHeadSha: async () => "sha-aaa" })
  const tmpl2 = new CodeAuditTemplate({ getHeadSha: async () => "sha-bbb" })

  const items1 = await tmpl1.resolveItems()
  const items2 = await tmpl2.resolveItems()

  assert.notEqual(items1[0].hash, items2[0].hash)
})

test("buildPrompt: contains audit instructions", () => {
  const tmpl = new CodeAuditTemplate({ getHeadSha: async () => "aaa" })
  const item: TemplateItem = {
    key: "repo-head",
    hash: "x",
    data: { headSha: "abc123" },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("## Code Audit"))
  assert.ok(prompt.includes("abc123"))
  assert.ok(prompt.includes("### Security Review"))
  assert.ok(prompt.includes("### Code Quality"))
  assert.ok(prompt.includes("### Output"))
})

test("buildPrompt: mentions OWASP", () => {
  const tmpl = new CodeAuditTemplate({ getHeadSha: async () => "aaa" })
  const item: TemplateItem = {
    key: "repo-head",
    hash: "x",
    data: { headSha: "abc123" },
  }
  const prompt = tmpl.buildPrompt(item)

  assert.ok(prompt.includes("OWASP Top 10"))
})

test("actionPolicy: allows create_issue", () => {
  const tmpl = new CodeAuditTemplate({ getHeadSha: async () => "aaa" })
  assert.ok(tmpl.actionPolicy.allow.includes("create_issue"))
})

test("actionPolicy: denies merge_pull_request", () => {
  const tmpl = new CodeAuditTemplate({ getHeadSha: async () => "aaa" })
  assert.ok(tmpl.actionPolicy.deny.includes("merge_pull_request"))
})

test("schedule: daily at 03:00 UTC", () => {
  const tmpl = new CodeAuditTemplate({ getHeadSha: async () => "aaa" })
  assert.equal(tmpl.schedule, "0 3 * * *")
})

// ── Runner ──

async function main() {
  console.log("Code Audit Template Tests (TASK-5.3)")
  console.log("=====================================")
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
