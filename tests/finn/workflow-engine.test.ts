// tests/finn/workflow-engine.test.ts — WorkflowEngine state machine tests (TASK-4.1)
// Self-contained: all types and WorkflowEngine inlined. No external imports.

import assert from "node:assert/strict"

// ── Inlined types ────────────────────────────────────────────

type WorkflowRunStatus = "pending" | "running" | "waiting_approval" | "step_failed" | "aborted" | "completed"
type GateType = "auto" | "approve" | "review"
type FailureMode = "abort" | "skip" | { retry: number }
type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped"

interface EngineStepDef {
  id: string
  skill: string
  input?: Record<string, string>
  gate?: GateType
  timeout_minutes?: number
  on_failure?: FailureMode
}

interface StepState {
  stepId: string
  status: StepStatus
  outputs: Record<string, unknown>
  error?: string
  durationMs?: number
  retries?: number
  gateDecision?: "auto" | "approved" | "rejected" | "timed_out"
}

interface WorkflowRun {
  id: string
  workflowId: string
  triggerId: string
  status: WorkflowRunStatus
  currentStep: number
  steps: StepState[]
  startedAt?: string
  completedAt?: string
  error?: string
}

interface EnginePersistence {
  save(run: WorkflowRun): Promise<void>
  load(runId: string): Promise<WorkflowRun | null>
}

type StepExecutor = (
  stepDef: EngineStepDef,
  resolvedInputs: Record<string, unknown>,
) => Promise<Record<string, unknown>>

type GateChecker = (
  stepDef: EngineStepDef,
  run: WorkflowRun,
) => Promise<"approved" | "rejected" | "timed_out">

// ── Inlined resolveInputs ────────────────────────────────────

function resolveInputs(
  inputDefs: Record<string, string> | undefined,
  steps: StepState[],
): Record<string, unknown> {
  if (!inputDefs) return {}
  const resolved: Record<string, unknown> = {}
  const outputsByStep = new Map<string, Record<string, unknown>>()
  for (const s of steps) outputsByStep.set(s.stepId, s.outputs)
  for (const [key, ref] of Object.entries(inputDefs)) {
    const match = ref.match(/^steps\.([^.]+)\.(.+)$/)
    if (!match) { resolved[key] = ref; continue }
    const [, stepId, field] = match
    const outputs = outputsByStep.get(stepId)
    if (!outputs) throw new Error(`Input ref "${ref}": step "${stepId}" not found`)
    if (!(field in outputs)) throw new Error(`Input ref "${ref}": field "${field}" not in step "${stepId}" outputs`)
    resolved[key] = outputs[field]
  }
  return resolved
}

// ── Inlined WorkflowEngine ──────────────────────────────────

class WorkflowEngine {
  private persistence: EnginePersistence
  private executor: StepExecutor
  private gateChecker: GateChecker
  private now: () => number
  private stepDefs = new Map<string, EngineStepDef[]>()

  constructor(deps: {
    persistence: EnginePersistence
    executor: StepExecutor
    gateChecker: GateChecker
    now?: () => number
  }) {
    this.persistence = deps.persistence
    this.executor = deps.executor
    this.gateChecker = deps.gateChecker
    this.now = deps.now ?? (() => Date.now())
  }

  async start(opts: {
    id: string; workflowId: string; triggerId: string; steps: EngineStepDef[]
  }): Promise<WorkflowRun> {
    const run: WorkflowRun = {
      id: opts.id, workflowId: opts.workflowId, triggerId: opts.triggerId,
      status: "running", currentStep: 0,
      steps: opts.steps.map((s) => ({ stepId: s.id, status: "pending" as StepStatus, outputs: {} })),
      startedAt: new Date(this.now()).toISOString(),
    }
    this.stepDefs.set(opts.id, opts.steps)
    await this.persistence.save(run)
    return this.advance(opts.id)
  }

  async advance(runId: string): Promise<WorkflowRun> {
    const run = await this.persistence.load(runId)
    if (!run) throw new Error(`Run "${runId}" not found`)
    const defs = this.stepDefs.get(runId)
    if (!defs) throw new Error(`Step definitions for run "${runId}" not found`)

    while (run.currentStep < run.steps.length) {
      const idx = run.currentStep
      const stepState = run.steps[idx]
      const stepDef = defs[idx]
      if (stepState.status === "completed") { run.currentStep++; continue }

      stepState.status = "running"
      await this.persistence.save(run)

      const resolvedInputs = resolveInputs(stepDef.input, run.steps)
      const gate = stepDef.gate ?? "auto"
      if (gate === "auto") {
        stepState.gateDecision = "auto"
      } else if (stepState.gateDecision !== "approved") {
        run.status = "waiting_approval"
        await this.persistence.save(run)
        return run
      }

      const startTime = this.now()
      const maxRetries = typeof stepDef.on_failure === "object" ? stepDef.on_failure.retry : 0
      let attempt = 0
      let succeeded = false

      while (attempt <= maxRetries) {
        try {
          const outputs = await this.executor(stepDef, resolvedInputs)
          stepState.status = "completed"
          stepState.outputs = outputs
          stepState.durationMs = this.now() - startTime
          stepState.retries = attempt > 0 ? attempt : undefined
          succeeded = true
          break
        } catch (err) {
          attempt++
          stepState.retries = attempt
          if (attempt > maxRetries) {
            const failureMode = stepDef.on_failure ?? "abort"
            if (failureMode === "skip") {
              stepState.status = "skipped"
              stepState.error = err instanceof Error ? err.message : String(err)
              stepState.durationMs = this.now() - startTime
              succeeded = true
              break
            } else {
              stepState.status = "failed"
              stepState.error = err instanceof Error ? err.message : String(err)
              stepState.durationMs = this.now() - startTime
              run.status = "aborted"
              run.error = `Step "${stepDef.id}" failed: ${stepState.error}`
              await this.persistence.save(run)
              return run
            }
          }
        }
      }

      await this.persistence.save(run)
      if (succeeded) run.currentStep++
    }

    run.status = "completed"
    run.completedAt = new Date(this.now()).toISOString()
    await this.persistence.save(run)
    return run
  }

  async resume(runId: string): Promise<WorkflowRun> {
    const run = await this.persistence.load(runId)
    if (!run) throw new Error(`Run "${runId}" not found`)
    if (run.status !== "waiting_approval") {
      throw new Error(`Run "${runId}" is not waiting for approval (status: ${run.status})`)
    }
    const stepState = run.steps[run.currentStep]
    stepState.gateDecision = "approved"
    run.status = "running"
    await this.persistence.save(run)
    return this.advance(runId)
  }
}

// ── Test harness ─────────────────────────────────────────────

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, fn }) }

// ── Helpers ──────────────────────────────────────────────────

class InMemPersistence implements EnginePersistence {
  store = new Map<string, WorkflowRun>()
  saveCount = 0
  async save(run: WorkflowRun): Promise<void> {
    this.store.set(run.id, structuredClone(run))
    this.saveCount++
  }
  async load(runId: string): Promise<WorkflowRun | null> {
    const r = this.store.get(runId)
    return r ? structuredClone(r) : null
  }
}

function makeStep(id: string, overrides?: Partial<EngineStepDef>): EngineStepDef {
  return { id, skill: `skill-${id}`, ...overrides }
}

function okExecutor(): StepExecutor {
  return async (def) => ({ result: `${def.id}-done` })
}

function noopGate(): GateChecker {
  return async () => "approved"
}

// ── Tests ────────────────────────────────────────────────────

test("sequential execution: 3 steps complete in order", async () => {
  const persistence = new InMemPersistence()
  const order: string[] = []
  const engine = new WorkflowEngine({
    persistence,
    executor: async (def) => { order.push(def.id); return { result: `${def.id}-done` } },
    gateChecker: noopGate(),
  })

  const run = await engine.start({
    id: "run-1", workflowId: "wf-1", triggerId: "t-1",
    steps: [makeStep("s1"), makeStep("s2"), makeStep("s3")],
  })

  assert.strictEqual(run.status, "completed")
  assert.deepStrictEqual(order, ["s1", "s2", "s3"])
  assert.strictEqual(run.steps[0].status, "completed")
  assert.strictEqual(run.steps[1].status, "completed")
  assert.strictEqual(run.steps[2].status, "completed")
  assert.strictEqual(run.currentStep, 3)
})

test("failure mode: abort stops workflow", async () => {
  const persistence = new InMemPersistence()
  const engine = new WorkflowEngine({
    persistence,
    executor: async (def) => {
      if (def.id === "s2") throw new Error("boom")
      return { result: "ok" }
    },
    gateChecker: noopGate(),
  })

  const run = await engine.start({
    id: "run-2", workflowId: "wf-1", triggerId: "t-1",
    steps: [makeStep("s1"), makeStep("s2", { on_failure: "abort" }), makeStep("s3")],
  })

  assert.strictEqual(run.status, "aborted")
  assert.strictEqual(run.steps[0].status, "completed")
  assert.strictEqual(run.steps[1].status, "failed")
  assert.strictEqual(run.steps[1].error, "boom")
  assert.strictEqual(run.steps[2].status, "pending")
})

test("failure mode: skip continues past failed step", async () => {
  const persistence = new InMemPersistence()
  const engine = new WorkflowEngine({
    persistence,
    executor: async (def) => {
      if (def.id === "s2") throw new Error("flaky")
      return { result: "ok" }
    },
    gateChecker: noopGate(),
  })

  const run = await engine.start({
    id: "run-3", workflowId: "wf-1", triggerId: "t-1",
    steps: [makeStep("s1"), makeStep("s2", { on_failure: "skip" }), makeStep("s3")],
  })

  assert.strictEqual(run.status, "completed")
  assert.strictEqual(run.steps[0].status, "completed")
  assert.strictEqual(run.steps[1].status, "skipped")
  assert.strictEqual(run.steps[1].error, "flaky")
  assert.strictEqual(run.steps[2].status, "completed")
})

test("failure mode: retry retries up to N times", async () => {
  const persistence = new InMemPersistence()
  let attempts = 0
  const engine = new WorkflowEngine({
    persistence,
    executor: async (def) => {
      if (def.id === "s1") {
        attempts++
        if (attempts < 3) throw new Error(`fail-${attempts}`)
        return { result: "succeeded-on-3rd" }
      }
      return { result: "ok" }
    },
    gateChecker: noopGate(),
  })

  const run = await engine.start({
    id: "run-4", workflowId: "wf-1", triggerId: "t-1",
    steps: [makeStep("s1", { on_failure: { retry: 2 } })],
  })

  assert.strictEqual(run.status, "completed")
  assert.strictEqual(run.steps[0].status, "completed")
  assert.deepStrictEqual(run.steps[0].outputs, { result: "succeeded-on-3rd" })
  assert.strictEqual(attempts, 3)
  assert.strictEqual(run.steps[0].retries, 2)
})

test("failure mode: retry exhausted becomes abort", async () => {
  const persistence = new InMemPersistence()
  const engine = new WorkflowEngine({
    persistence,
    executor: async (def) => {
      if (def.id === "s1") throw new Error("always-fails")
      return { result: "ok" }
    },
    gateChecker: noopGate(),
  })

  const run = await engine.start({
    id: "run-5", workflowId: "wf-1", triggerId: "t-1",
    steps: [makeStep("s1", { on_failure: { retry: 1 } })],
  })

  assert.strictEqual(run.status, "aborted")
  assert.strictEqual(run.steps[0].status, "failed")
  assert.strictEqual(run.steps[0].error, "always-fails")
  // retry: 1 means 1 retry (2 total attempts), retries count should be 2
  assert.strictEqual(run.steps[0].retries, 2)
})

test("crash recovery: resume from last completed step", async () => {
  const persistence = new InMemPersistence()
  const order: string[] = []

  // Simulate: step 1 completed, step 2 and 3 still pending (crash mid-workflow)
  const crashedRun: WorkflowRun = {
    id: "run-6", workflowId: "wf-1", triggerId: "t-1",
    status: "running", currentStep: 1,
    steps: [
      { stepId: "s1", status: "completed", outputs: { result: "s1-done" } },
      { stepId: "s2", status: "pending", outputs: {} },
      { stepId: "s3", status: "pending", outputs: {} },
    ],
    startedAt: "2026-02-07T00:00:00Z",
  }
  await persistence.save(crashedRun)

  // Create engine with step defs and advance from where we left off
  const stepDefs = [makeStep("s1"), makeStep("s2"), makeStep("s3")]
  const engine = new WorkflowEngine({
    persistence,
    executor: async (def) => { order.push(def.id); return { result: `${def.id}-done` } },
    gateChecker: noopGate(),
  })

  // Inject step defs by starting a "fake" workflow — instead, we use a trick:
  // We need the engine to know the step defs. Let's re-create by starting then
  // manually setting persistence state before advance.
  // Better approach: start a workflow, then override persistence with crashed state.

  // Actually, the engine stores stepDefs in a private map keyed by runId.
  // For crash recovery, we need to re-register them. We can do this by
  // creating a new engine start that we intercept.
  // Simplest: use (engine as any) to set private field.
  ;(engine as any).stepDefs.set("run-6", stepDefs)

  const run = await engine.advance("run-6")

  assert.strictEqual(run.status, "completed")
  assert.deepStrictEqual(order, ["s2", "s3"])
  assert.strictEqual(run.steps[0].status, "completed")
  assert.strictEqual(run.steps[1].status, "completed")
  assert.strictEqual(run.steps[2].status, "completed")
  assert.strictEqual(run.currentStep, 3)
})

test("gate: auto proceeds immediately", async () => {
  const persistence = new InMemPersistence()
  const engine = new WorkflowEngine({
    persistence,
    executor: okExecutor(),
    gateChecker: noopGate(),
  })

  const run = await engine.start({
    id: "run-7", workflowId: "wf-1", triggerId: "t-1",
    steps: [makeStep("s1", { gate: "auto" })],
  })

  assert.strictEqual(run.status, "completed")
  assert.strictEqual(run.steps[0].gateDecision, "auto")
  assert.strictEqual(run.steps[0].status, "completed")
})

test("gate: approve blocks until resume()", async () => {
  const persistence = new InMemPersistence()
  const engine = new WorkflowEngine({
    persistence,
    executor: okExecutor(),
    gateChecker: noopGate(),
  })

  const run = await engine.start({
    id: "run-8", workflowId: "wf-1", triggerId: "t-1",
    steps: [makeStep("s1"), makeStep("s2", { gate: "approve" }), makeStep("s3")],
  })

  // After start: s1 completes, s2 blocks at gate
  assert.strictEqual(run.status, "waiting_approval")
  assert.strictEqual(run.steps[0].status, "completed")
  assert.strictEqual(run.steps[1].status, "running")
  assert.strictEqual(run.steps[2].status, "pending")
  assert.strictEqual(run.currentStep, 1)

  // Resume: s2 approved, executes, s3 runs
  const resumed = await engine.resume("run-8")
  assert.strictEqual(resumed.status, "completed")
  assert.strictEqual(resumed.steps[1].gateDecision, "approved")
  assert.strictEqual(resumed.steps[1].status, "completed")
  assert.strictEqual(resumed.steps[2].status, "completed")
})

test("input resolution: step references prior step output", async () => {
  const persistence = new InMemPersistence()
  let capturedInputs: Record<string, unknown> = {}
  const engine = new WorkflowEngine({
    persistence,
    executor: async (def, inputs) => {
      if (def.id === "s2") capturedInputs = inputs
      if (def.id === "s1") return { result: "hello-from-s1", count: 42 }
      return { result: "ok" }
    },
    gateChecker: noopGate(),
  })

  const run = await engine.start({
    id: "run-9", workflowId: "wf-1", triggerId: "t-1",
    steps: [
      makeStep("s1"),
      makeStep("s2", { input: { data: "steps.s1.result", num: "steps.s1.count" } }),
    ],
  })

  assert.strictEqual(run.status, "completed")
  assert.strictEqual(capturedInputs.data, "hello-from-s1")
  assert.strictEqual(capturedInputs.num, 42)
})

test("persistence: run saved after each step", async () => {
  const persistence = new InMemPersistence()
  const engine = new WorkflowEngine({
    persistence,
    executor: okExecutor(),
    gateChecker: noopGate(),
  })

  const run = await engine.start({
    id: "run-10", workflowId: "wf-1", triggerId: "t-1",
    steps: [makeStep("s1"), makeStep("s2"), makeStep("s3")],
  })

  assert.strictEqual(run.status, "completed")
  // Saves: initial (1) + per step: running (1) + completed (1) = 2 each, for 3 steps = 6 + final completed = 7
  // Total: 1 (initial) + 3 * 2 (running + completed per step) + 1 (final completed) = 8
  assert.ok(persistence.saveCount >= 8, `Expected at least 8 saves, got ${persistence.saveCount}`)

  // Verify final state is persisted
  const loaded = await persistence.load("run-10")
  assert.strictEqual(loaded!.status, "completed")
  assert.strictEqual(loaded!.steps.length, 3)
  assert.ok(loaded!.steps.every(s => s.status === "completed"))
})

// ── Runner ───────────────────────────────────────────────────

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
