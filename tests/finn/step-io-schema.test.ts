// tests/finn/step-io-schema.test.ts — Step I/O Schema validation tests (SDD 4.3)
// Self-contained: all types and logic inlined (no imports from Beauvoir)

import assert from "node:assert/strict"

// ── Inlined Types ───────────────────────────────────────────

type StepFieldType = "string" | "path" | "json" | "branch" | "number" | "boolean"

interface StepFieldDef {
  type: StepFieldType
  required?: boolean
  description?: string
}

interface StepIOSchema {
  inputs: Record<string, StepFieldDef>
  outputs: Record<string, StepFieldDef>
}

type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped"

interface StepResult {
  stepId: string
  status: StepStatus
  outputs: Record<string, unknown>
  error?: string
  durationMs?: number
  artifacts?: string[]
}

// ── Inlined Validation Logic ────────────────────────────────

const BRANCH_RE = /^[a-zA-Z0-9_\-/.]+$/

function checkType(value: unknown, fieldType: StepFieldType): string | null {
  switch (fieldType) {
    case "string":
      return typeof value === "string" ? null : `expected string, got ${typeof value}`
    case "number":
      return typeof value === "number" ? null : `expected number, got ${typeof value}`
    case "boolean":
      return typeof value === "boolean" ? null : `expected boolean, got ${typeof value}`
    case "path":
      return typeof value === "string" ? null : `expected path (string), got ${typeof value}`
    case "branch":
      if (typeof value !== "string") return `expected branch (string), got ${typeof value}`
      return BRANCH_RE.test(value) ? null : `invalid branch name: ${value}`
    case "json":
      return null
    default:
      return `unknown field type: ${fieldType}`
  }
}

function validateFields(
  values: Record<string, unknown>,
  schema: Record<string, StepFieldDef>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  for (const [name, def] of Object.entries(schema)) {
    const value = values[name]
    const isPresent = value !== undefined && value !== null
    if (def.required !== false && !isPresent) {
      errors.push(`missing required field: ${name}`)
      continue
    }
    if (isPresent) {
      const typeErr = checkType(value, def.type)
      if (typeErr) errors.push(`field '${name}': ${typeErr}`)
    }
  }
  return { valid: errors.length === 0, errors }
}

function validateOutputs(
  outputs: Record<string, unknown>,
  schema: StepIOSchema["outputs"],
): { valid: boolean; errors: string[] } {
  return validateFields(outputs, schema)
}

function validateInputs(
  inputs: Record<string, unknown>,
  schema: StepIOSchema["inputs"],
): { valid: boolean; errors: string[] } {
  return validateFields(inputs, schema)
}

function serializeStepResult(result: StepResult): string {
  return JSON.stringify(result)
}

function deserializeStepResult(json: string): StepResult {
  const parsed = JSON.parse(json)
  if (!parsed || typeof parsed !== "object") throw new Error("invalid StepResult: expected object")
  if (typeof parsed.stepId !== "string") throw new Error("invalid StepResult: missing stepId")
  if (typeof parsed.status !== "string") throw new Error("invalid StepResult: missing status")
  if (!parsed.outputs || typeof parsed.outputs !== "object") throw new Error("invalid StepResult: missing outputs")
  return parsed as StepResult
}

// ── Test Harness ────────────────────────────────────────────

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Tests ───────────────────────────────────────────────────

test("validateOutputs: passes with all required outputs present", () => {
  const schema: StepIOSchema["outputs"] = {
    prUrl: { type: "string", required: true },
    reviewScore: { type: "number", required: true },
  }
  const result = validateOutputs({ prUrl: "https://github.com/org/repo/pull/1", reviewScore: 85 }, schema)
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

test("validateOutputs: fails when required output missing", () => {
  const schema: StepIOSchema["outputs"] = {
    prUrl: { type: "string", required: true },
    branch: { type: "branch", required: true },
  }
  const result = validateOutputs({ prUrl: "https://example.com" }, schema)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes("missing required field: branch")))
})

test("validateOutputs: passes with optional output missing", () => {
  const schema: StepIOSchema["outputs"] = {
    prUrl: { type: "string", required: true },
    notes: { type: "string", required: false },
  }
  const result = validateOutputs({ prUrl: "https://example.com" }, schema)
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

test("validateOutputs: type check string", () => {
  const schema: StepIOSchema["outputs"] = {
    name: { type: "string", required: true },
  }
  const result = validateOutputs({ name: 42 }, schema)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes("expected string")))
})

test("validateOutputs: type check number", () => {
  const schema: StepIOSchema["outputs"] = {
    count: { type: "number", required: true },
  }
  const result = validateOutputs({ count: "not-a-number" }, schema)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes("expected number")))
})

test("validateOutputs: type check boolean", () => {
  const schema: StepIOSchema["outputs"] = {
    approved: { type: "boolean", required: true },
  }
  const result = validateOutputs({ approved: "yes" }, schema)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes("expected boolean")))
})

test("validateOutputs: type check path", () => {
  const schema: StepIOSchema["outputs"] = {
    filePath: { type: "path", required: true },
  }
  // path must be a string
  const result = validateOutputs({ filePath: 123 }, schema)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes("expected path (string)")))

  // valid path passes
  const ok1 = validateOutputs({ filePath: "/usr/local/bin" }, schema)
  assert.equal(ok1.valid, true)
  const ok2 = validateOutputs({ filePath: "relative/path.ts" }, schema)
  assert.equal(ok2.valid, true)
})

test("validateInputs: passes with valid inputs", () => {
  const schema: StepIOSchema["inputs"] = {
    repo: { type: "string", required: true },
    prNumber: { type: "number", required: true },
    dryRun: { type: "boolean", required: false },
  }
  const result = validateInputs({ repo: "org/repo", prNumber: 42 }, schema)
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

test("validateInputs: fails with missing required input", () => {
  const schema: StepIOSchema["inputs"] = {
    repo: { type: "string", required: true },
    prNumber: { type: "number", required: true },
  }
  const result = validateInputs({ repo: "org/repo" }, schema)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes("missing required field: prNumber")))
})

test("serializeStepResult: roundtrip", () => {
  const original: StepResult = {
    stepId: "step-review",
    status: "completed",
    outputs: { prUrl: "https://github.com/org/repo/pull/1", score: 95 },
    error: undefined,
    durationMs: 1234,
    artifacts: ["/tmp/review.md", "/tmp/diff.patch"],
  }
  const json = serializeStepResult(original)
  const restored = deserializeStepResult(json)
  assert.deepEqual(restored.stepId, original.stepId)
  assert.deepEqual(restored.status, original.status)
  assert.deepEqual(restored.outputs, original.outputs)
  assert.deepEqual(restored.durationMs, original.durationMs)
  assert.deepEqual(restored.artifacts, original.artifacts)
})

test("StepResult: default values", () => {
  const result: StepResult = {
    stepId: "step-1",
    status: "pending",
    outputs: {},
  }
  assert.equal(result.stepId, "step-1")
  assert.equal(result.status, "pending")
  assert.deepEqual(result.outputs, {})
  assert.equal(result.error, undefined)
  assert.equal(result.durationMs, undefined)
  assert.equal(result.artifacts, undefined)
})

// ── Runner ──────────────────────────────────────────────────

async function main() {
  console.log("Step I/O Schema Validation Tests")
  console.log("================================")

  let passed = 0
  let failed = 0

  for (const t of tests) {
    try {
      await t.fn()
      console.log(`  PASS  ${t.name}`)
      passed++
    } catch (err) {
      console.error(`  FAIL  ${t.name}`)
      console.error(err)
      failed++
      process.exitCode = 1
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`)
}

main()
