// tests/finn/workflow-persistence.test.ts — WorkflowPersistence tests (TASK-4.5)
// Self-contained: all types and InMemoryWorkflowPersistence inlined.

import assert from "node:assert/strict"

// --- Inlined types ---

type WorkflowRunStatus = "pending" | "running" | "waiting_approval" | "step_failed" | "aborted" | "completed"

interface WorkflowRunRecord {
  id: string
  workflowId: string
  triggerId: string
  status: WorkflowRunStatus
  currentStep: number
  steps: Array<{
    stepId: string
    status: string
    outputs: Record<string, unknown>
    error?: string
    durationMs?: number
  }>
  startedAt?: string
  completedAt?: string
  error?: string
}

interface StepOutputRecord {
  stepId: string
  outputs: Record<string, unknown>
  savedAt: string
}

interface WorkflowPersistence {
  save(run: WorkflowRunRecord): Promise<void>
  load(runId: string): Promise<WorkflowRunRecord | null>
  list(filter?: { workflowId?: string; status?: WorkflowRunStatus }): Promise<WorkflowRunRecord[]>
  saveStepOutput(runId: string, output: StepOutputRecord): Promise<void>
  loadStepOutput(runId: string, stepId: string): Promise<StepOutputRecord | null>
  delete(runId: string): Promise<boolean>
}

// --- Inlined InMemoryWorkflowPersistence ---

class InMemoryWorkflowPersistence implements WorkflowPersistence {
  private runs = new Map<string, WorkflowRunRecord>()
  private stepOutputs = new Map<string, StepOutputRecord>()

  async save(run: WorkflowRunRecord): Promise<void> {
    this.runs.set(run.id, structuredClone(run))
  }

  async load(runId: string): Promise<WorkflowRunRecord | null> {
    const run = this.runs.get(runId)
    return run ? structuredClone(run) : null
  }

  async list(filter?: { workflowId?: string; status?: WorkflowRunStatus }): Promise<WorkflowRunRecord[]> {
    let results = Array.from(this.runs.values())
    if (filter?.workflowId) results = results.filter(r => r.workflowId === filter.workflowId)
    if (filter?.status) results = results.filter(r => r.status === filter.status)
    return results.map(r => structuredClone(r))
  }

  async saveStepOutput(runId: string, output: StepOutputRecord): Promise<void> {
    this.stepOutputs.set(`${runId}/${output.stepId}`, structuredClone(output))
  }

  async loadStepOutput(runId: string, stepId: string): Promise<StepOutputRecord | null> {
    const out = this.stepOutputs.get(`${runId}/${stepId}`)
    return out ? structuredClone(out) : null
  }

  async delete(runId: string): Promise<boolean> {
    const existed = this.runs.has(runId)
    this.runs.delete(runId)
    for (const key of this.stepOutputs.keys()) {
      if (key.startsWith(`${runId}/`)) this.stepOutputs.delete(key)
    }
    return existed
  }
}

// --- Test harness ---

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, fn }) }

// --- Helper: create a minimal run record ---

function makeRun(overrides: Partial<WorkflowRunRecord> & { id: string }): WorkflowRunRecord {
  return {
    workflowId: "wf-default",
    triggerId: "trig-1",
    status: "pending",
    currentStep: 0,
    steps: [],
    ...overrides,
  }
}

// --- Tests ---

test("save and load roundtrip", async () => {
  const store = new InMemoryWorkflowPersistence()
  const run = makeRun({
    id: "run-1",
    workflowId: "wf-deploy",
    status: "running",
    currentStep: 1,
    steps: [{ stepId: "s1", status: "completed", outputs: { url: "https://example.com" }, durationMs: 120 }],
    startedAt: "2026-02-07T00:00:00Z",
  })
  await store.save(run)
  const loaded = await store.load("run-1")
  assert.deepStrictEqual(loaded, run)
})

test("load returns null for unknown ID", async () => {
  const store = new InMemoryWorkflowPersistence()
  const result = await store.load("nonexistent")
  assert.strictEqual(result, null)
})

test("save overwrites existing run", async () => {
  const store = new InMemoryWorkflowPersistence()
  const run = makeRun({ id: "run-2", status: "pending" })
  await store.save(run)
  const updated = { ...run, status: "completed" as const, completedAt: "2026-02-07T01:00:00Z" }
  await store.save(updated)
  const loaded = await store.load("run-2")
  assert.strictEqual(loaded!.status, "completed")
  assert.strictEqual(loaded!.completedAt, "2026-02-07T01:00:00Z")
})

test("list returns all runs", async () => {
  const store = new InMemoryWorkflowPersistence()
  await store.save(makeRun({ id: "r1" }))
  await store.save(makeRun({ id: "r2" }))
  await store.save(makeRun({ id: "r3" }))
  const all = await store.list()
  assert.strictEqual(all.length, 3)
})

test("list filters by workflowId", async () => {
  const store = new InMemoryWorkflowPersistence()
  await store.save(makeRun({ id: "r1", workflowId: "wf-a" }))
  await store.save(makeRun({ id: "r2", workflowId: "wf-a" }))
  await store.save(makeRun({ id: "r3", workflowId: "wf-b" }))
  const filtered = await store.list({ workflowId: "wf-a" })
  assert.strictEqual(filtered.length, 2)
  assert.ok(filtered.every(r => r.workflowId === "wf-a"))
})

test("list filters by status", async () => {
  const store = new InMemoryWorkflowPersistence()
  await store.save(makeRun({ id: "r1", status: "completed" }))
  await store.save(makeRun({ id: "r2", status: "running" }))
  await store.save(makeRun({ id: "r3", status: "completed" }))
  await store.save(makeRun({ id: "r4", status: "aborted" }))
  const filtered = await store.list({ status: "completed" })
  assert.strictEqual(filtered.length, 2)
  assert.ok(filtered.every(r => r.status === "completed"))
})

test("saveStepOutput and loadStepOutput roundtrip", async () => {
  const store = new InMemoryWorkflowPersistence()
  const output: StepOutputRecord = {
    stepId: "step-build",
    outputs: { artifact: "build.tar.gz", size: 1024 },
    savedAt: "2026-02-07T00:05:00Z",
  }
  await store.saveStepOutput("run-1", output)
  const loaded = await store.loadStepOutput("run-1", "step-build")
  assert.deepStrictEqual(loaded, output)
})

test("loadStepOutput returns null for unknown", async () => {
  const store = new InMemoryWorkflowPersistence()
  const result = await store.loadStepOutput("run-x", "step-x")
  assert.strictEqual(result, null)
})

test("delete removes run and step outputs", async () => {
  const store = new InMemoryWorkflowPersistence()
  const run = makeRun({ id: "run-del" })
  await store.save(run)
  await store.saveStepOutput("run-del", { stepId: "s1", outputs: { a: 1 }, savedAt: "2026-02-07T00:00:00Z" })
  await store.saveStepOutput("run-del", { stepId: "s2", outputs: { b: 2 }, savedAt: "2026-02-07T00:01:00Z" })

  const deleted = await store.delete("run-del")
  assert.strictEqual(deleted, true)
  assert.strictEqual(await store.load("run-del"), null)
  assert.strictEqual(await store.loadStepOutput("run-del", "s1"), null)
  assert.strictEqual(await store.loadStepOutput("run-del", "s2"), null)
})

test("delete returns false for unknown ID", async () => {
  const store = new InMemoryWorkflowPersistence()
  const result = await store.delete("nonexistent")
  assert.strictEqual(result, false)
})

test("save returns deep copy (mutation safety)", async () => {
  const store = new InMemoryWorkflowPersistence()
  const run = makeRun({
    id: "run-mut",
    steps: [{ stepId: "s1", status: "completed", outputs: { val: "original" } }],
  })
  await store.save(run)

  // Mutate the original after saving
  run.status = "aborted"
  run.steps[0].outputs.val = "mutated"
  run.steps.push({ stepId: "s2", status: "pending", outputs: {} })

  // Loaded copy should be unchanged
  const loaded = await store.load("run-mut")
  assert.strictEqual(loaded!.status, "pending")
  assert.strictEqual(loaded!.steps.length, 1)
  assert.strictEqual(loaded!.steps[0].outputs.val, "original")
})

// --- Runner ---

async function main() {
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
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`)
  if (failed > 0) process.exit(1)
}

main()
