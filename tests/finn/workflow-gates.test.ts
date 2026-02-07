// tests/finn/workflow-gates.test.ts — Gate Semantics tests (TASK-4.4)
// Self-contained: all types and GateEvaluator inlined (no external imports).

import assert from "node:assert/strict"

// ── Inlined Types ────────────────────────────────────────────

type GateType = "auto" | "approve" | "review"
type GateDecision = "auto_proceed" | "approved" | "rejected" | "timed_out"

interface GateConfig {
  type: GateType
  timeout_minutes?: number
}

interface GateState {
  stepId: string
  gate: GateConfig
  decision?: GateDecision
  notifiedAt?: string
  decidedAt?: string
  decidedBy?: string
}

interface GateNotification {
  stepId: string
  workflowRunId: string
  gateType: GateType
  message: string
  timeout_minutes: number
}

// ── Inlined GateEvaluator ────────────────────────────────────

class GateEvaluator {
  private readonly now: () => number

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now())
  }

  evaluate(state: GateState): {
    action: "proceed" | "block" | "reject"
    decision: GateDecision
  } {
    const gateType = state.gate.type

    if (gateType === "auto") {
      return { action: "proceed", decision: "auto_proceed" }
    }

    if (this.isTimedOut(state)) {
      return gateType === "approve"
        ? { action: "reject", decision: "timed_out" }
        : { action: "proceed", decision: "timed_out" }
    }

    if (state.decision === "approved") {
      return { action: "proceed", decision: "approved" }
    }
    if (state.decision === "rejected") {
      return { action: "reject", decision: "rejected" }
    }

    return { action: "block", decision: "auto_proceed" }
  }

  approve(state: GateState, approvedBy?: string): GateState {
    return {
      ...state,
      decision: "approved",
      decidedAt: new Date(this.now()).toISOString(),
      decidedBy: approvedBy ?? "unknown",
    }
  }

  reject(state: GateState, rejectedBy?: string): GateState {
    return {
      ...state,
      decision: "rejected",
      decidedAt: new Date(this.now()).toISOString(),
      decidedBy: rejectedBy ?? "unknown",
    }
  }

  isTimedOut(state: GateState): boolean {
    if (!state.notifiedAt) return false
    const timeoutMs = (state.gate.timeout_minutes ?? 60) * 60 * 1000
    const notifiedMs = new Date(state.notifiedAt).getTime()
    return this.now() - notifiedMs >= timeoutMs
  }

  createGateState(stepId: string, config: GateConfig): GateState {
    return {
      stepId,
      gate: {
        type: config.type,
        timeout_minutes: config.timeout_minutes ?? 60,
      },
      notifiedAt: new Date(this.now()).toISOString(),
    }
  }

  buildNotification(state: GateState, workflowRunId: string): GateNotification {
    const timeout = state.gate.timeout_minutes ?? 60
    const gateType = state.gate.type
    const verb = gateType === "approve" ? "approval" : "review"
    return {
      stepId: state.stepId,
      workflowRunId,
      gateType,
      message: `Step "${state.stepId}" requires ${verb} (timeout: ${timeout}m)`,
      timeout_minutes: timeout,
    }
  }
}

// ── Test Harness ─────────────────────────────────────────────

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

// ── Tests ────────────────────────────────────────────────────

async function main() {
  console.log("Workflow Gate Semantics Tests")
  console.log("============================")

  const BASE_TIME = 1700000000000 // 2023-11-14T22:13:20.000Z

  // ── 1. Auto gate proceeds immediately ──────────────────────

  await test("auto gate: proceeds immediately", () => {
    const eval_ = new GateEvaluator()
    const state: GateState = {
      stepId: "step-1",
      gate: { type: "auto" },
    }
    const result = eval_.evaluate(state)
    assert.equal(result.action, "proceed")
    assert.equal(result.decision, "auto_proceed")
  })

  // ── 2. Approve gate blocks when no decision ────────────────

  await test("approve gate: blocks when no decision", () => {
    let now = BASE_TIME
    const eval_ = new GateEvaluator({ now: () => now })
    const state: GateState = {
      stepId: "step-2",
      gate: { type: "approve", timeout_minutes: 60 },
      notifiedAt: new Date(now).toISOString(),
    }
    // Still within timeout window
    now += 10 * 60 * 1000 // 10 minutes later
    const result = eval_.evaluate(state)
    assert.equal(result.action, "block")
  })

  // ── 3. Approve gate proceeds when approved ─────────────────

  await test("approve gate: proceeds when approved", () => {
    let now = BASE_TIME
    const eval_ = new GateEvaluator({ now: () => now })
    let state: GateState = {
      stepId: "step-3",
      gate: { type: "approve", timeout_minutes: 60 },
      notifiedAt: new Date(now).toISOString(),
    }
    state = eval_.approve(state, "user-42")
    const result = eval_.evaluate(state)
    assert.equal(result.action, "proceed")
    assert.equal(result.decision, "approved")
    assert.equal(state.decidedBy, "user-42")
    assert.ok(state.decidedAt)
  })

  // ── 4. Approve gate rejects when rejected ──────────────────

  await test("approve gate: rejects when rejected", () => {
    let now = BASE_TIME
    const eval_ = new GateEvaluator({ now: () => now })
    let state: GateState = {
      stepId: "step-4",
      gate: { type: "approve", timeout_minutes: 60 },
      notifiedAt: new Date(now).toISOString(),
    }
    state = eval_.reject(state, "user-99")
    const result = eval_.evaluate(state)
    assert.equal(result.action, "reject")
    assert.equal(result.decision, "rejected")
    assert.equal(state.decidedBy, "user-99")
  })

  // ── 5. Approve gate rejects on timeout ─────────────────────

  await test("approve gate: rejects on timeout", () => {
    let now = BASE_TIME
    const eval_ = new GateEvaluator({ now: () => now })
    const state: GateState = {
      stepId: "step-5",
      gate: { type: "approve", timeout_minutes: 30 },
      notifiedAt: new Date(now).toISOString(),
    }
    // Advance past timeout
    now += 31 * 60 * 1000 // 31 minutes
    const result = eval_.evaluate(state)
    assert.equal(result.action, "reject")
    assert.equal(result.decision, "timed_out")
  })

  // ── 6. Review gate blocks before timeout ───────────────────

  await test("review gate: blocks when no decision (before timeout)", () => {
    let now = BASE_TIME
    const eval_ = new GateEvaluator({ now: () => now })
    const state: GateState = {
      stepId: "step-6",
      gate: { type: "review", timeout_minutes: 60 },
      notifiedAt: new Date(now).toISOString(),
    }
    // 10 minutes in — still within timeout
    now += 10 * 60 * 1000
    const result = eval_.evaluate(state)
    assert.equal(result.action, "block")
  })

  // ── 7. Review gate auto-proceeds on timeout ────────────────

  await test("review gate: auto-proceeds on timeout", () => {
    let now = BASE_TIME
    const eval_ = new GateEvaluator({ now: () => now })
    const state: GateState = {
      stepId: "step-7",
      gate: { type: "review", timeout_minutes: 30 },
      notifiedAt: new Date(now).toISOString(),
    }
    // Advance past timeout
    now += 31 * 60 * 1000
    const result = eval_.evaluate(state)
    // Unlike approve, review auto-proceeds on timeout
    assert.equal(result.action, "proceed")
    assert.equal(result.decision, "timed_out")
  })

  // ── 8. Review gate respects explicit rejection ─────────────

  await test("review gate: respects explicit rejection before timeout", () => {
    let now = BASE_TIME
    const eval_ = new GateEvaluator({ now: () => now })
    let state: GateState = {
      stepId: "step-8",
      gate: { type: "review", timeout_minutes: 60 },
      notifiedAt: new Date(now).toISOString(),
    }
    state = eval_.reject(state, "reviewer-1")
    const result = eval_.evaluate(state)
    assert.equal(result.action, "reject")
    assert.equal(result.decision, "rejected")
  })

  // ── 9. buildNotification creates correct notification ──────

  await test("buildNotification: creates correct notification", () => {
    const eval_ = new GateEvaluator()
    const state: GateState = {
      stepId: "deploy",
      gate: { type: "approve", timeout_minutes: 45 },
    }
    const notif = eval_.buildNotification(state, "run-abc-123")
    assert.equal(notif.stepId, "deploy")
    assert.equal(notif.workflowRunId, "run-abc-123")
    assert.equal(notif.gateType, "approve")
    assert.equal(notif.timeout_minutes, 45)
    assert.ok(notif.message.includes("deploy"))
    assert.ok(notif.message.includes("approval"))
  })

  // ── 10. createGateState defaults timeout to 60 ─────────────

  await test("createGateState: defaults timeout to 60 minutes", () => {
    const fixedNow = BASE_TIME
    const eval_ = new GateEvaluator({ now: () => fixedNow })
    const state = eval_.createGateState("step-init", { type: "review" })
    assert.equal(state.stepId, "step-init")
    assert.equal(state.gate.type, "review")
    assert.equal(state.gate.timeout_minutes, 60)
    assert.equal(state.notifiedAt, new Date(fixedNow).toISOString())
    assert.equal(state.decision, undefined)
  })

  console.log("\nDone.")
}

main()
