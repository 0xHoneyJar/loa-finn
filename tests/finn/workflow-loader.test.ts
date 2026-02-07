// tests/finn/workflow-loader.test.ts — Workflow loader tests (SDD §4.2)
// Self-contained: all types and implementation inlined. No external imports.

import assert from "node:assert/strict"

// ── Inline types (mirrors beauvoir loader.ts) ──

type GateType = "auto" | "approve" | "review"
type FailureMode = "abort" | "skip" | { retry: number }

interface StepDefinition {
  id: string
  skill: string
  input?: Record<string, string>
  gate?: GateType
  timeout_minutes?: number
  on_failure?: FailureMode
}

interface TriggerDefinition {
  type: "cron" | "webhook" | "label"
  schedule?: string
  label?: string
  event?: string
}

interface WorkflowDefinition {
  name: string
  description: string
  trigger: TriggerDefinition
  steps: StepDefinition[]
}

// ── Inline minimal YAML subset parser ──

type YamlValue = string | number | boolean | YamlValue[] | { [key: string]: YamlValue }

function parseYamlValue(raw: string): string | number | boolean {
  const trimmed = raw.trim()
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return trimmed
}

function indentLevel(line: string): number {
  const match = line.match(/^(\s*)/)
  return match ? match[1].length : 0
}

function parseYamlLines(lines: string[], start: number, baseIndent: number): { value: YamlValue; end: number } {
  const result: Record<string, YamlValue> = {}
  let i = start

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === "" || line.trim().startsWith("#")) { i++; continue }
    const indent = indentLevel(line)
    if (indent < baseIndent) break
    if (indent > baseIndent) break

    const trimmed = line.trim()

    // Array item at this level
    if (trimmed.startsWith("- ")) {
      const arr: YamlValue[] = []
      while (i < lines.length) {
        const arrLine = lines[i]
        if (arrLine.trim() === "" || arrLine.trim().startsWith("#")) { i++; continue }
        const arrIndent = indentLevel(arrLine)
        if (arrIndent < baseIndent) break
        if (arrIndent !== baseIndent || !arrLine.trim().startsWith("- ")) break

        const afterDash = arrLine.trim().slice(2)
        const colonIdx = afterDash.indexOf(":")
        if (colonIdx !== -1 && (colonIdx === afterDash.length - 1 || afterDash[colonIdx + 1] === " ")) {
          const objItemIndent = baseIndent + 2
          const key = afterDash.slice(0, colonIdx).trim()
          const valPart = afterDash.slice(colonIdx + 1).trim()
          const obj: Record<string, YamlValue> = {}
          if (valPart) {
            obj[key] = parseYamlValue(valPart)
          } else {
            i++
            const nested = parseYamlLines(lines, i, objItemIndent + 2)
            obj[key] = nested.value
            i = nested.end
          }
          if (!valPart) {
            // already advanced
          } else {
            i++
          }
          while (i < lines.length) {
            const sibLine = lines[i]
            if (sibLine.trim() === "" || sibLine.trim().startsWith("#")) { i++; continue }
            const sibIndent = indentLevel(sibLine)
            if (sibIndent < objItemIndent) break
            if (sibIndent !== objItemIndent) break
            const sibTrimmed = sibLine.trim()
            const sibColon = sibTrimmed.indexOf(":")
            if (sibColon === -1) break
            const sibKey = sibTrimmed.slice(0, sibColon).trim()
            const sibVal = sibTrimmed.slice(sibColon + 1).trim()
            if (sibVal) {
              obj[sibKey] = parseYamlValue(sibVal)
              i++
            } else {
              i++
              const sibNested = parseYamlLines(lines, i, sibIndent + 2)
              obj[sibKey] = sibNested.value
              i = sibNested.end
            }
          }
          arr.push(obj)
        } else {
          arr.push(parseYamlValue(afterDash))
          i++
        }
      }
      return { value: arr, end: i }
    }

    // Key: value pair
    const colonIdx = trimmed.indexOf(":")
    if (colonIdx === -1) { i++; continue }
    const key = trimmed.slice(0, colonIdx).trim()
    const valPart = trimmed.slice(colonIdx + 1).trim()

    if (valPart) {
      result[key] = parseYamlValue(valPart)
      i++
    } else {
      i++
      while (i < lines.length && (lines[i].trim() === "" || lines[i].trim().startsWith("#"))) i++
      if (i < lines.length) {
        const nextIndent = indentLevel(lines[i])
        if (nextIndent > baseIndent) {
          const nested = parseYamlLines(lines, i, nextIndent)
          result[key] = nested.value
          i = nested.end
        }
      }
    }
  }

  return { value: result, end: i }
}

function parseYaml(yaml: string): YamlValue {
  const lines = yaml.split("\n")
  const { value } = parseYamlLines(lines, 0, 0)
  return value
}

function coerceFailureMode(raw: YamlValue | undefined): FailureMode | undefined {
  if (raw === undefined || raw === null) return undefined
  if (raw === "abort" || raw === "skip") return raw
  if (typeof raw === "object" && !Array.isArray(raw) && typeof (raw as Record<string, YamlValue>).retry === "number") {
    return { retry: (raw as Record<string, YamlValue>).retry as number }
  }
  return undefined
}

// ── Inline implementation (mirrors beauvoir loader.ts) ──

function parseWorkflow(yamlContent: string): WorkflowDefinition {
  const raw = parseYaml(yamlContent) as Record<string, YamlValue>
  const trigger = raw.trigger as Record<string, YamlValue>
  const rawSteps = raw.steps as YamlValue[]

  const steps: StepDefinition[] = (rawSteps ?? []).map((s) => {
    const step = s as Record<string, YamlValue>
    const def: StepDefinition = {
      id: String(step.id),
      skill: String(step.skill),
    }
    if (step.input !== undefined) def.input = step.input as Record<string, string>
    if (step.gate !== undefined) def.gate = String(step.gate) as GateType
    if (step.timeout_minutes !== undefined) def.timeout_minutes = Number(step.timeout_minutes)
    if (step.on_failure !== undefined) def.on_failure = coerceFailureMode(step.on_failure)
    return def
  })

  return {
    name: String(raw.name),
    description: String(raw.description),
    trigger: {
      type: String(trigger.type) as TriggerDefinition["type"],
      ...(trigger.schedule !== undefined ? { schedule: String(trigger.schedule) } : {}),
      ...(trigger.label !== undefined ? { label: String(trigger.label) } : {}),
      ...(trigger.event !== undefined ? { event: String(trigger.event) } : {}),
    },
    steps,
  }
}

function validateWorkflow(def: WorkflowDefinition): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  const seen = new Set<string>()
  for (const step of def.steps) {
    if (seen.has(step.id)) {
      errors.push(`Duplicate step ID: "${step.id}"`)
    }
    seen.add(step.id)
  }

  const validGates: GateType[] = ["auto", "approve", "review"]
  const seenSoFar = new Set<string>()
  for (const step of def.steps) {
    if (step.input) {
      for (const [key, ref] of Object.entries(step.input)) {
        const match = ref.match(/^steps\.([^.]+)\..+$/)
        if (match) {
          const refId = match[1]
          if (!seen.has(refId)) {
            errors.push(`Step "${step.id}" input "${key}" references unknown step "${refId}"`)
          } else if (!seenSoFar.has(refId)) {
            errors.push(`Step "${step.id}" input "${key}" has forward reference to step "${refId}"`)
          }
        }
      }
    }

    if (step.gate !== undefined && !validGates.includes(step.gate as GateType)) {
      errors.push(`Step "${step.id}" has invalid gate type: "${step.gate}"`)
    }

    if (step.on_failure !== undefined) {
      const fm = step.on_failure
      if (fm !== "abort" && fm !== "skip" && (typeof fm !== "object" || typeof (fm as { retry: number }).retry !== "number")) {
        errors.push(`Step "${step.id}" has invalid on_failure: ${JSON.stringify(fm)}`)
      }
    }

    seenSoFar.add(step.id)
  }

  return { valid: errors.length === 0, errors }
}

function resolveInputRef(ref: string, stepOutputs: Map<string, Record<string, unknown>>): unknown {
  const match = ref.match(/^steps\.([^.]+)\.(.+)$/)
  if (!match) throw new Error(`Invalid input reference format: "${ref}"`)

  const [, stepId, field] = match
  const outputs = stepOutputs.get(stepId)
  if (!outputs) throw new Error(`Step "${stepId}" not found in outputs`)
  if (!(field in outputs)) throw new Error(`Field "${field}" not found in step "${stepId}" outputs`)
  return outputs[field]
}

// ── Test harness ──

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── 1. parseWorkflow: parses valid workflow YAML ──

test("parseWorkflow: parses valid workflow YAML", () => {
  const yaml = `
name: pr-from-issue
description: Create a PR from an issue with analysis and implementation
trigger:
  type: label
  label: auto-implement
steps:
  - id: analyze
    skill: issue-analyzer
    gate: auto
    timeout_minutes: 5
    on_failure: abort
  - id: implement
    skill: code-writer
    input:
      prd: steps.analyze.prd
      spec: steps.analyze.spec
    gate: review
    timeout_minutes: 30
  - id: pr
    skill: pr-creator
    input:
      branch: steps.implement.branch
      summary: steps.analyze.summary
    gate: approve
    on_failure: skip
`.trim()

  const wf = parseWorkflow(yaml)

  assert.equal(wf.name, "pr-from-issue")
  assert.equal(wf.description, "Create a PR from an issue with analysis and implementation")
  assert.equal(wf.trigger.type, "label")
  assert.equal(wf.trigger.label, "auto-implement")
  assert.equal(wf.steps.length, 3)

  assert.equal(wf.steps[0].id, "analyze")
  assert.equal(wf.steps[0].skill, "issue-analyzer")
  assert.equal(wf.steps[0].gate, "auto")
  assert.equal(wf.steps[0].timeout_minutes, 5)
  assert.equal(wf.steps[0].on_failure, "abort")

  assert.equal(wf.steps[1].id, "implement")
  assert.equal(wf.steps[1].skill, "code-writer")
  assert.deepEqual(wf.steps[1].input, { prd: "steps.analyze.prd", spec: "steps.analyze.spec" })
  assert.equal(wf.steps[1].gate, "review")
  assert.equal(wf.steps[1].timeout_minutes, 30)

  assert.equal(wf.steps[2].id, "pr")
  assert.equal(wf.steps[2].skill, "pr-creator")
  assert.deepEqual(wf.steps[2].input, { branch: "steps.implement.branch", summary: "steps.analyze.summary" })
  assert.equal(wf.steps[2].gate, "approve")
  assert.equal(wf.steps[2].on_failure, "skip")
})

// ── 2. parseWorkflow: handles minimal workflow ──

test("parseWorkflow: handles minimal workflow", () => {
  const yaml = `
name: simple
description: A minimal workflow
trigger:
  type: cron
  schedule: "0 * * * *"
steps:
  - id: run
    skill: health-check
`.trim()

  const wf = parseWorkflow(yaml)

  assert.equal(wf.name, "simple")
  assert.equal(wf.description, "A minimal workflow")
  assert.equal(wf.trigger.type, "cron")
  assert.equal(wf.trigger.schedule, "0 * * * *")
  assert.equal(wf.steps.length, 1)
  assert.equal(wf.steps[0].id, "run")
  assert.equal(wf.steps[0].skill, "health-check")
  assert.equal(wf.steps[0].gate, undefined)
  assert.equal(wf.steps[0].input, undefined)
})

// ── 3. validateWorkflow: passes for valid workflow ──

test("validateWorkflow: passes for valid workflow", () => {
  const wf: WorkflowDefinition = {
    name: "valid",
    description: "A valid workflow",
    trigger: { type: "webhook", event: "push" },
    steps: [
      { id: "a", skill: "lint", gate: "auto" },
      { id: "b", skill: "test", input: { result: "steps.a.output" }, gate: "review" },
    ],
  }

  const result = validateWorkflow(wf)
  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
})

// ── 4. validateWorkflow: detects duplicate step IDs ──

test("validateWorkflow: detects duplicate step IDs", () => {
  const wf: WorkflowDefinition = {
    name: "dup",
    description: "Has duplicate IDs",
    trigger: { type: "cron", schedule: "0 0 * * *" },
    steps: [
      { id: "build", skill: "compiler" },
      { id: "build", skill: "packager" },
    ],
  }

  const result = validateWorkflow(wf)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some(e => e.includes('Duplicate step ID: "build"')))
})

// ── 5. validateWorkflow: detects invalid input reference (unknown step) ──

test("validateWorkflow: detects invalid input reference (unknown step)", () => {
  const wf: WorkflowDefinition = {
    name: "bad-ref",
    description: "References nonexistent step",
    trigger: { type: "label", label: "go" },
    steps: [
      { id: "a", skill: "analyzer" },
      { id: "b", skill: "writer", input: { data: "steps.nonexistent.field" } },
    ],
  }

  const result = validateWorkflow(wf)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some(e => e.includes("nonexistent")))
})

// ── 6. validateWorkflow: detects forward references ──

test("validateWorkflow: detects forward references", () => {
  const wf: WorkflowDefinition = {
    name: "fwd-ref",
    description: "First step references second",
    trigger: { type: "cron", schedule: "0 0 * * *" },
    steps: [
      { id: "first", skill: "reader", input: { data: "steps.second.output" } },
      { id: "second", skill: "writer" },
    ],
  }

  const result = validateWorkflow(wf)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some(e => e.includes("forward reference")))
})

// ── 7. validateWorkflow: rejects invalid gate type ──

test("validateWorkflow: rejects invalid gate type", () => {
  const wf: WorkflowDefinition = {
    name: "bad-gate",
    description: "Invalid gate value",
    trigger: { type: "webhook", event: "pr" },
    steps: [
      { id: "step1", skill: "runner", gate: "yolo" as GateType },
    ],
  }

  const result = validateWorkflow(wf)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some(e => e.includes("invalid gate type")))
})

// ── 8. resolveInputRef: resolves valid reference ──

test("resolveInputRef: resolves valid reference", () => {
  const outputs = new Map<string, Record<string, unknown>>()
  outputs.set("analyze", { prd: "## Product Requirements\nBuild the thing", summary: "short" })

  const val = resolveInputRef("steps.analyze.prd", outputs)
  assert.equal(val, "## Product Requirements\nBuild the thing")
})

// ── 9. resolveInputRef: throws for missing step ──

test("resolveInputRef: throws for missing step", () => {
  const outputs = new Map<string, Record<string, unknown>>()
  outputs.set("analyze", { prd: "doc" })

  assert.throws(
    () => resolveInputRef("steps.ghost.prd", outputs),
    (err: Error) => err.message.includes('"ghost" not found'),
  )
})

// ── 10. resolveInputRef: throws for missing field ──

test("resolveInputRef: throws for missing field", () => {
  const outputs = new Map<string, Record<string, unknown>>()
  outputs.set("analyze", { prd: "doc" })

  assert.throws(
    () => resolveInputRef("steps.analyze.missing_field", outputs),
    (err: Error) => err.message.includes('"missing_field" not found'),
  )
})

// ── Runner ──

async function main() {
  console.log("Workflow Loader Tests")
  console.log("=====================")

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
