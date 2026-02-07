// tests/finn/template-registry.test.ts — Template registry + hash tests (SDD 3.2)

import assert from "node:assert/strict"
import { createHash } from "node:crypto"

// ── Inline types + classes (self-contained, mirrors beauvoir base.ts) ──

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

class TemplateRegistry {
  private templates = new Map<string, BaseTemplate>()

  register(template: BaseTemplate): void {
    this.templates.set(template.id, template)
  }

  get(id: string): BaseTemplate | undefined {
    return this.templates.get(id)
  }

  list(): BaseTemplate[] {
    return Array.from(this.templates.values())
  }
}

// ── Concrete test template ──

class StubTemplate extends BaseTemplate {
  readonly id: string
  readonly name: string
  readonly actionPolicy: ActionPolicyDef
  readonly canonicalHashFields: string[]
  readonly excludedHashFields: string[]

  constructor(id: string, name: string, canonical: string[], excluded: string[] = []) {
    super()
    this.id = id
    this.name = name
    this.canonicalHashFields = canonical
    this.excludedHashFields = excluded
    this.actionPolicy = { templateId: id, allow: ["read"], deny: ["delete"], constraints: {} }
  }

  async resolveItems(): Promise<TemplateItem[]> {
    return []
  }

  buildPrompt(item: TemplateItem): string {
    return `Process ${item.key}`
  }
}

// ── Test harness ──

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── 1. Registry CRUD ──

test("TemplateRegistry: register, get, list", () => {
  const registry = new TemplateRegistry()
  const t1 = new StubTemplate("pr-review", "PR Review", ["title", "body"])
  const t2 = new StubTemplate("issue-triage", "Issue Triage", ["title", "labels"])

  registry.register(t1)
  registry.register(t2)

  assert.equal(registry.get("pr-review"), t1)
  assert.equal(registry.get("issue-triage"), t2)
  assert.equal(registry.list().length, 2)
})

test("TemplateRegistry: get returns undefined for unknown", () => {
  const registry = new TemplateRegistry()
  assert.equal(registry.get("nonexistent"), undefined)
})

// ── 2. Hash computation ──

test("computeStateHash: deterministic for same fields", () => {
  const tmpl = new StubTemplate("t1", "T1", ["title", "body"])
  const item: TemplateItem = { key: "k1", hash: "", data: { title: "Fix bug", body: "Details" } }

  const h1 = tmpl.computeStateHash(item)
  const h2 = tmpl.computeStateHash(item)
  assert.equal(h1, h2)
  assert.equal(h1.length, 64) // SHA-256 hex length
})

test("computeStateHash: different for different fields", () => {
  const tmpl = new StubTemplate("t1", "T1", ["title", "body"])
  const itemA: TemplateItem = { key: "k1", hash: "", data: { title: "Fix bug", body: "v1" } }
  const itemB: TemplateItem = { key: "k1", hash: "", data: { title: "Fix bug", body: "v2" } }

  assert.notEqual(tmpl.computeStateHash(itemA), tmpl.computeStateHash(itemB))
})

test("computeStateHash: excludes excludedHashFields", () => {
  const tmplWithExclude = new StubTemplate("t1", "T1", ["title", "body", "updatedAt"], ["updatedAt"])
  const tmplWithout = new StubTemplate("t2", "T2", ["title", "body"], [])

  const item: TemplateItem = {
    key: "k1",
    hash: "",
    data: { title: "Fix", body: "Details", updatedAt: Date.now() },
  }

  // Hash should be the same since updatedAt is excluded from t1
  // and not a canonical field of t2
  assert.equal(tmplWithExclude.computeStateHash(item), tmplWithout.computeStateHash(item))
})

test("computeStateHash: sorts keys canonically", () => {
  const tmpl = new StubTemplate("t1", "T1", ["body", "title"])
  // Data keys in different insertion order
  const itemA: TemplateItem = { key: "k1", hash: "", data: { title: "X", body: "Y" } }
  const itemB: TemplateItem = { key: "k1", hash: "", data: { body: "Y", title: "X" } }

  assert.equal(tmpl.computeStateHash(itemA), tmpl.computeStateHash(itemB))
})

// ── Runner ──

async function main() {
  console.log("Template Registry Tests")
  console.log("=======================")

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
