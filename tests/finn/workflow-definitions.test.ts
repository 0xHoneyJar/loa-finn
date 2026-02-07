// tests/finn/workflow-definitions.test.ts — Workflow YAML definition validation (TASK-4.7)
// Self-contained: reads YAML files from disk, validates with inlined parser. No vitest.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// ── Constants ──

const WORKFLOWS_DIR = "/home/merlin/Documents/thj/code/loa-beauvoir/grimoires/loa/workflows"

// ── Inline types (mirrors beauvoir workflow types) ──

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

// ── Workflow parser (mirrors beauvoir loader) ──

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

// ── Load all workflow files ──

function loadWorkflow(filename: string): WorkflowDefinition {
  const filepath = resolve(WORKFLOWS_DIR, filename)
  const content = readFileSync(filepath, "utf-8")
  return parseWorkflow(content)
}

const prFromIssue = loadWorkflow("pr-from-issue.yaml")
const quickReview = loadWorkflow("quick-review.yaml")
const dailyAudit = loadWorkflow("daily-audit.yaml")

// ── Test harness ──

const tests: { name: string; fn: () => void }[] = []
function test(name: string, fn: () => void): void {
  tests.push({ name, fn })
}

// ── Test 1: pr-from-issue.yaml has 7 steps ──

test("pr-from-issue.yaml: loads and has 7 steps", () => {
  assert.equal(prFromIssue.steps.length, 7, `Expected 7 steps, got ${prFromIssue.steps.length}`)
})

// ── Test 2: pr-from-issue.yaml step IDs in order ──

test("pr-from-issue.yaml: steps have correct IDs", () => {
  const expectedIds = ["analyze", "architect", "sprint", "implement", "review", "audit", "create-pr"]
  const actualIds = prFromIssue.steps.map((s) => s.id)
  assert.deepEqual(actualIds, expectedIds)
})

// ── Test 3: pr-from-issue.yaml input references are valid (no forward/invalid refs) ──

test("pr-from-issue.yaml: all input references are valid", () => {
  const seenIds = new Set<string>()
  const allIds = new Set(prFromIssue.steps.map((s) => s.id))

  for (const step of prFromIssue.steps) {
    if (step.input) {
      for (const [key, ref] of Object.entries(step.input)) {
        const match = ref.match(/^steps\.([^.]+)\..+$/)
        assert.ok(match, `Step "${step.id}" input "${key}" has invalid ref format: "${ref}"`)
        const refId = match![1]
        assert.ok(allIds.has(refId), `Step "${step.id}" input "${key}" references unknown step "${refId}"`)
        assert.ok(seenIds.has(refId), `Step "${step.id}" input "${key}" has forward reference to "${refId}"`)
      }
    }
    seenIds.add(step.id)
  }
})

// ── Test 4: pr-from-issue.yaml timeouts set for all steps ──

test("pr-from-issue.yaml: timeouts set for all steps", () => {
  for (const step of prFromIssue.steps) {
    assert.ok(
      step.timeout_minutes !== undefined && step.timeout_minutes > 0,
      `Step "${step.id}" missing or invalid timeout_minutes`,
    )
  }
})

// ── Test 5: quick-review.yaml single step, cron trigger ──

test("quick-review.yaml: single step, cron trigger", () => {
  assert.equal(quickReview.name, "quick-review")
  assert.equal(quickReview.trigger.type, "cron")
  assert.equal(quickReview.trigger.schedule, "*/30 * * * *")
  assert.equal(quickReview.steps.length, 1)
  assert.equal(quickReview.steps[0].id, "review")
  assert.equal(quickReview.steps[0].skill, "pr-review")
  assert.equal(quickReview.steps[0].on_failure, "skip")
})

// ── Test 6: daily-audit.yaml two steps, cron trigger ──

test("daily-audit.yaml: two steps, cron trigger", () => {
  assert.equal(dailyAudit.name, "daily-audit")
  assert.equal(dailyAudit.trigger.type, "cron")
  assert.equal(dailyAudit.trigger.schedule, "0 3 * * *")
  assert.equal(dailyAudit.steps.length, 2)
  assert.equal(dailyAudit.steps[0].id, "audit")
  assert.equal(dailyAudit.steps[1].id, "report")
  assert.deepEqual(dailyAudit.steps[1].input, { findings: "steps.audit.findings" })
})

// ── Test 7: all workflows have unique names ──

test("all workflows: names are unique", () => {
  const names = [prFromIssue.name, quickReview.name, dailyAudit.name]
  const unique = new Set(names)
  assert.equal(unique.size, names.length, `Duplicate workflow names found: ${JSON.stringify(names)}`)
})

// ── Test 8: all workflows triggers have required fields ──

test("all workflows: triggers have required fields", () => {
  const workflows = [prFromIssue, quickReview, dailyAudit]

  for (const wf of workflows) {
    assert.ok(wf.trigger.type, `Workflow "${wf.name}" trigger missing type`)

    switch (wf.trigger.type) {
      case "cron":
        assert.ok(wf.trigger.schedule, `Workflow "${wf.name}" cron trigger missing schedule`)
        break
      case "label":
        assert.ok(wf.trigger.label, `Workflow "${wf.name}" label trigger missing label`)
        break
      case "webhook":
        assert.ok(wf.trigger.event, `Workflow "${wf.name}" webhook trigger missing event`)
        break
      default:
        assert.fail(`Workflow "${wf.name}" has unknown trigger type: ${wf.trigger.type}`)
    }
  }
})

// ── Runner ──

async function main() {
  console.log("Workflow Definition Tests")
  console.log("=========================")

  let passed = 0
  let failed = 0

  for (const t of tests) {
    try {
      t.fn()
      passed++
      console.log(`  PASS  ${t.name}`)
    } catch (err: unknown) {
      failed++
      console.error(`  FAIL  ${t.name}`)
      console.error(`    ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`)
  if (failed > 0) process.exit(1)
}

main()
