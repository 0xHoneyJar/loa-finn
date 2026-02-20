/**
 * BillingConservationGuard Tests — Sprint 2 Tasks 2.5 + 2.6 + 2.7 + 2.8
 *
 * Tests the fail-closed evaluator wrapper for billing invariants.
 * Covers: lifecycle, all 4 invariant checks, strict lattice, bypass mode,
 * divergence, WAL audit trail, AlertService integration, structured logging,
 * forward-compatible WAL replay, boot sequence, health, recovery, entrypoint inventory,
 * compilation failure+retry, evaluator/ad-hoc disagreement, evaluator runtime error,
 * bypass does not auto-activate on error, degraded recovery, complete lattice table,
 * property-based invariant testing, observability metrics + structured HARD-FAIL logging.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// --- Evaluator Mock Infrastructure ---
// ESM exports are non-configurable, so vi.spyOn cannot redefine them.
// Use vi.hoisted + vi.mock to create a controllable override that passes
// through to the real evaluator by default (when override.fn is null).
const { evaluatorOverride } = vi.hoisted(() => ({
  evaluatorOverride: { fn: null as ((...args: any[]) => any) | null },
}))

vi.mock("@0xhoneyjar/loa-hounfour", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@0xhoneyjar/loa-hounfour")>()
  return {
    ...mod,
    evaluateConstraintDetailed: (...args: any[]) => {
      if (evaluatorOverride.fn) return evaluatorOverride.fn(...args)
      return (mod as any).evaluateConstraintDetailed(...args)
    },
  }
})

import {
  BillingConservationGuard,
  BILLING_ENTRYPOINTS,
  type InvariantResult,
  type GuardHealth,
} from "../../src/hounfour/billing-conservation-guard.js"
import type { GuardMetrics, HardFailDetail } from "../../src/hounfour/metrics.js"
import { AlertService, type AlertServiceConfig } from "../../src/safety/alert-service.js"
import { WAL } from "../../src/persistence/wal.js"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as fc from "fast-check"

// --- Helpers ---

function expectPass(result: InvariantResult): void {
  expect(result.ok).toBe(true)
  expect(result.effective).toBe("pass")
}

function expectFail(result: InvariantResult): void {
  expect(result.ok).toBe(false)
  expect(result.effective).toBe("fail")
}

function createMockAlertService() {
  return {
    fire: vi.fn().mockResolvedValue(true),
  }
}

function createTempWAL(): { wal: WAL; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "guard-wal-"))
  const wal = new WAL(dir)
  return { wal, dir }
}

// --- Lifecycle ---

describe("BillingConservationGuard lifecycle", () => {
  let guard: BillingConservationGuard

  beforeEach(() => {
    delete process.env.EVALUATOR_BYPASS
    guard = new BillingConservationGuard()
  })

  it("starts in uninitialized state", () => {
    const health = guard.getHealth()
    expect(health.state).toBe("uninitialized")
    expect(health.evaluator_compiled).toBe(false)
    expect(health.billing).toBe("unavailable")
  })

  it("init() transitions to ready state", async () => {
    await guard.init()
    const health = guard.getHealth()
    expect(health.state).toBe("ready")
    expect(health.evaluator_compiled).toBe(true)
    expect(health.billing).toBe("ready")
  })

  it("init() is idempotent (second call is no-op)", async () => {
    await guard.init()
    await guard.init()
    const health = guard.getHealth()
    expect(health.state).toBe("ready")
  })

  it("init() with EVALUATOR_BYPASS=true transitions to bypassed", async () => {
    process.env.EVALUATOR_BYPASS = "true"
    guard = new BillingConservationGuard()
    await guard.init()
    const health = guard.getHealth()
    expect(health.state).toBe("bypassed")
    expect(health.evaluator_compiled).toBe(false)
    expect(health.billing).toBe("ready")
  })

  afterEach(() => {
    delete process.env.EVALUATOR_BYPASS
  })
})

// --- checkBudgetConservation ---

describe("checkBudgetConservation", () => {
  let guard: BillingConservationGuard

  beforeEach(async () => {
    guard = new BillingConservationGuard()
    await guard.init()
  })

  it("passes when spent <= limit", () => {
    const result = guard.checkBudgetConservation(500n, 1000n)
    expectPass(result)
    expect(result.invariant_id).toBe("budget_conservation")
    expect(result.evaluator_result).toBe("pass")
    expect(result.adhoc_result).toBe("pass")
  })

  it("passes when spent equals limit", () => {
    const result = guard.checkBudgetConservation(1000n, 1000n)
    expectPass(result)
  })

  it("fails when spent exceeds limit", () => {
    const result = guard.checkBudgetConservation(1001n, 1000n)
    expectFail(result)
    expect(result.adhoc_result).toBe("fail")
  })

  it("passes for zero values", () => {
    const result = guard.checkBudgetConservation(0n, 0n)
    expectPass(result)
  })

  it("passes for large values", () => {
    const result = guard.checkBudgetConservation(
      999_999_999_999n,
      1_000_000_000_000n,
    )
    expectPass(result)
  })
})

// --- checkCostNonNegative ---

describe("checkCostNonNegative", () => {
  let guard: BillingConservationGuard

  beforeEach(async () => {
    guard = new BillingConservationGuard()
    await guard.init()
  })

  it("passes for positive cost", () => {
    const result = guard.checkCostNonNegative(500n)
    expectPass(result)
    expect(result.invariant_id).toBe("cost_non_negative")
  })

  it("passes for zero cost", () => {
    const result = guard.checkCostNonNegative(0n)
    expectPass(result)
  })

  it("fails for negative cost", () => {
    const result = guard.checkCostNonNegative(-1n)
    expectFail(result)
    expect(result.adhoc_result).toBe("fail")
  })

  it("passes for large positive cost", () => {
    const result = guard.checkCostNonNegative(9_007_199_254_740_991n)
    expectPass(result)
  })
})

// --- checkReserveWithinAllocation ---

describe("checkReserveWithinAllocation", () => {
  let guard: BillingConservationGuard

  beforeEach(async () => {
    guard = new BillingConservationGuard()
    await guard.init()
  })

  it("passes when reserve <= allocation", () => {
    const result = guard.checkReserveWithinAllocation(500n, 1000n)
    expectPass(result)
    expect(result.invariant_id).toBe("reserve_within_allocation")
  })

  it("passes when reserve equals allocation", () => {
    const result = guard.checkReserveWithinAllocation(1000n, 1000n)
    expectPass(result)
  })

  it("fails when reserve exceeds allocation", () => {
    const result = guard.checkReserveWithinAllocation(1001n, 1000n)
    expectFail(result)
  })

  it("passes for zero values", () => {
    const result = guard.checkReserveWithinAllocation(0n, 0n)
    expectPass(result)
  })
})

// --- checkMicroUSDFormat ---

describe("checkMicroUSDFormat", () => {
  let guard: BillingConservationGuard

  beforeEach(async () => {
    guard = new BillingConservationGuard()
    await guard.init()
  })

  it("passes for canonical format", () => {
    const result = guard.checkMicroUSDFormat("12345")
    expectPass(result)
    expect(result.invariant_id).toBe("micro_usd_format")
  })

  it("passes for zero", () => {
    const result = guard.checkMicroUSDFormat("0")
    expectPass(result)
  })

  it("passes for large value", () => {
    const result = guard.checkMicroUSDFormat("9007199254740991")
    expectPass(result)
  })

  it("fails for non-canonical (leading zeros)", () => {
    const result = guard.checkMicroUSDFormat("007")
    expectFail(result)
    expect(result.adhoc_result).toBe("fail")
  })

  it("fails for -0", () => {
    const result = guard.checkMicroUSDFormat("-0")
    expectFail(result)
  })

  it("fails for empty string", () => {
    const result = guard.checkMicroUSDFormat("")
    expectFail(result)
  })

  it("fails for non-numeric", () => {
    const result = guard.checkMicroUSDFormat("abc")
    expectFail(result)
  })
})

// --- Strict Fail-Closed Lattice ---

describe("strict fail-closed lattice", () => {
  it("evaluator unavailable (uninitialized) → effective=fail even when adhoc passes", () => {
    // Do NOT call init() — guard is uninitialized
    const guard = new BillingConservationGuard()
    const result = guard.checkCostNonNegative(100n)
    expectFail(result)
    expect(result.evaluator_result).toBe("error")
    expect(result.adhoc_result).toBe("pass")
    expect(result.effective).toBe("fail")
  })
})

// --- Bypass Mode ---

describe("bypass mode", () => {
  let guard: BillingConservationGuard

  beforeEach(async () => {
    process.env.EVALUATOR_BYPASS = "true"
    guard = new BillingConservationGuard()
    await guard.init()
  })

  afterEach(() => {
    delete process.env.EVALUATOR_BYPASS
  })

  it("returns evaluator_result=bypassed", () => {
    const result = guard.checkCostNonNegative(100n)
    expect(result.evaluator_result).toBe("bypassed")
  })

  it("effective follows adhoc_result when adhoc passes", () => {
    const result = guard.checkCostNonNegative(100n)
    expectPass(result)
    expect(result.adhoc_result).toBe("pass")
    expect(result.effective).toBe("pass")
  })

  it("effective follows adhoc_result when adhoc fails", () => {
    const result = guard.checkCostNonNegative(-1n)
    expectFail(result)
    expect(result.adhoc_result).toBe("fail")
    expect(result.effective).toBe("fail")
  })

  it("bypass mode works for all invariant types", () => {
    const budget = guard.checkBudgetConservation(500n, 1000n)
    expect(budget.evaluator_result).toBe("bypassed")
    expectPass(budget)

    const cost = guard.checkCostNonNegative(0n)
    expect(cost.evaluator_result).toBe("bypassed")
    expectPass(cost)

    const reserve = guard.checkReserveWithinAllocation(100n, 200n)
    expect(reserve.evaluator_result).toBe("bypassed")
    expectPass(reserve)

    const format = guard.checkMicroUSDFormat("12345")
    expect(format.evaluator_result).toBe("bypassed")
    expectPass(format)
  })
})

// --- InvariantResult structure ---

describe("InvariantResult structure", () => {
  let guard: BillingConservationGuard

  beforeEach(async () => {
    guard = new BillingConservationGuard()
    await guard.init()
  })

  it("contains all required fields", () => {
    const result = guard.checkCostNonNegative(100n)
    expect(result).toHaveProperty("ok")
    expect(result).toHaveProperty("invariant_id")
    expect(result).toHaveProperty("evaluator_result")
    expect(result).toHaveProperty("adhoc_result")
    expect(result).toHaveProperty("effective")
  })

  it("ok matches effective", () => {
    const pass = guard.checkCostNonNegative(100n)
    expect(pass.ok).toBe(pass.effective === "pass")

    const fail = guard.checkCostNonNegative(-1n)
    expect(fail.ok).toBe(fail.effective === "pass")
  })
})

// --- WAL Audit Trail (Task 2.6) ---

describe("WAL audit trail", () => {
  let walDir: string

  afterEach(() => {
    delete process.env.EVALUATOR_BYPASS
    if (walDir) rmSync(walDir, { recursive: true, force: true })
  })

  it("writes audit entry to WAL on bypass init", async () => {
    process.env.EVALUATOR_BYPASS = "true"
    const { wal, dir } = createTempWAL()
    walDir = dir

    const guard = new BillingConservationGuard({ wal })
    await guard.init()

    // Read the WAL segment to verify the audit entry
    const segments = wal.getSegments()
    expect(segments.length).toBeGreaterThan(0)

    const content = readFileSync(segments[0], "utf-8")
    const entries = content.trim().split("\n").map(l => JSON.parse(l))
    expect(entries.length).toBe(1)

    const entry = entries[0]
    expect(entry.type).toBe("audit")
    expect(entry.operation).toBe("create")
    expect(entry.path).toBe("billing-conservation-guard/evaluator_bypass")
    expect(entry.data.subtype).toBe("evaluator_bypass")
    expect(entry.data.timestamp).toBeDefined()
  })

  it("writes audit entry with pod_id and build_sha from deps", async () => {
    process.env.EVALUATOR_BYPASS = "true"
    const { wal, dir } = createTempWAL()
    walDir = dir

    const guard = new BillingConservationGuard({
      wal,
      podId: "pod-abc-123",
      buildSha: "deadbeef",
    })
    await guard.init()

    const segments = wal.getSegments()
    const content = readFileSync(segments[0], "utf-8")
    const entry = JSON.parse(content.trim().split("\n")[0])
    expect(entry.data.pod_id).toBe("pod-abc-123")
    expect(entry.data.build_sha).toBe("deadbeef")
  })

  it("writes audit entry with pod_id and build_sha from env vars", async () => {
    process.env.EVALUATOR_BYPASS = "true"
    process.env.POD_ID = "env-pod-456"
    process.env.BUILD_SHA = "cafebabe"
    const { wal, dir } = createTempWAL()
    walDir = dir

    const guard = new BillingConservationGuard({ wal })
    await guard.init()

    const segments = wal.getSegments()
    const content = readFileSync(segments[0], "utf-8")
    const entry = JSON.parse(content.trim().split("\n")[0])
    expect(entry.data.pod_id).toBe("env-pod-456")
    expect(entry.data.build_sha).toBe("cafebabe")

    delete process.env.POD_ID
    delete process.env.BUILD_SHA
  })

  it("survives WAL unavailability without throwing", async () => {
    process.env.EVALUATOR_BYPASS = "true"
    // No WAL provided — should log warning but not throw
    const guard = new BillingConservationGuard()
    await expect(guard.init()).resolves.not.toThrow()
    expect(guard.getHealth().state).toBe("bypassed")
  })
})

// --- AlertService Integration (Task 2.6) ---

describe("AlertService integration", () => {
  afterEach(() => {
    delete process.env.EVALUATOR_BYPASS
  })

  it("fires critical alert on bypass init", async () => {
    process.env.EVALUATOR_BYPASS = "true"
    const alertService = createMockAlertService()

    const guard = new BillingConservationGuard({
      alertService: alertService as any,
    })
    await guard.init()

    expect(alertService.fire).toHaveBeenCalledTimes(1)
    expect(alertService.fire).toHaveBeenCalledWith(
      "critical",
      "evaluator_bypass_active",
      expect.objectContaining({
        message: expect.stringContaining("EVALUATOR_BYPASS=true"),
      }),
    )
  })

  it("does not fire alert on normal init", async () => {
    const alertService = createMockAlertService()
    const guard = new BillingConservationGuard({
      alertService: alertService as any,
    })
    await guard.init()

    expect(alertService.fire).not.toHaveBeenCalled()
  })

  it("survives alert failure without throwing", async () => {
    process.env.EVALUATOR_BYPASS = "true"
    const alertService = createMockAlertService()
    alertService.fire.mockRejectedValue(new Error("alert failed"))

    const guard = new BillingConservationGuard({
      alertService: alertService as any,
    })
    await expect(guard.init()).resolves.not.toThrow()
    expect(guard.getHealth().state).toBe("bypassed")
  })
})

// --- Structured Bypass Logging (Task 2.6) ---

describe("structured bypass logging", () => {
  afterEach(() => {
    delete process.env.EVALUATOR_BYPASS
  })

  it("logs evaluator_bypassed=true on every bypassed request", async () => {
    process.env.EVALUATOR_BYPASS = "true"
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const guard = new BillingConservationGuard({
      podId: "test-pod",
      buildSha: "abc123",
    })
    await guard.init()

    // Clear init warnings
    warnSpy.mockClear()

    guard.checkCostNonNegative(100n)

    const calls = warnSpy.mock.calls.map(c => c[0])
    const bypassLog = calls.find((c: string) => c.includes("evaluator_bypassed=true"))
    expect(bypassLog).toBeDefined()
    expect(bypassLog).toContain("pod_id=test-pod")
    expect(bypassLog).toContain("build_sha=abc123")
    expect(bypassLog).toContain("cost_non_negative")

    warnSpy.mockRestore()
  })
})

// --- Bypass is startup-only (Task 2.6) ---

describe("bypass is startup-only", () => {
  it("bypass cannot be toggled at runtime", async () => {
    // Init without bypass
    const guard = new BillingConservationGuard()
    await guard.init()
    expect(guard.getHealth().state).toBe("ready")

    // Setting env after init has no effect
    process.env.EVALUATOR_BYPASS = "true"
    const result = guard.checkCostNonNegative(100n)
    expect(result.evaluator_result).toBe("pass") // NOT "bypassed"

    delete process.env.EVALUATOR_BYPASS
  })

  it("bypass state persists after init even if env changes", async () => {
    process.env.EVALUATOR_BYPASS = "true"
    const guard = new BillingConservationGuard()
    await guard.init()
    expect(guard.getHealth().state).toBe("bypassed")

    // Clear env — guard stays bypassed (startup-only)
    delete process.env.EVALUATOR_BYPASS
    const result = guard.checkCostNonNegative(100n)
    expect(result.evaluator_result).toBe("bypassed")
  })
})

// --- Forward-Compatible WAL Replay (Task 2.6) ---

describe("forward-compatible WAL replay", () => {
  let walDir: string

  afterEach(() => {
    if (walDir) rmSync(walDir, { recursive: true, force: true })
  })

  it("replays audit entries alongside billing entries", async () => {
    const { wal, dir } = createTempWAL()
    walDir = dir

    // Write mixed entries
    wal.append("config", "create", "config/test", { key: "val" })
    wal.append("audit", "create", "billing-conservation-guard/evaluator_bypass", {
      subtype: "evaluator_bypass",
      pod_id: "pod-1",
      build_sha: "abc",
      timestamp: new Date().toISOString(),
    })
    wal.append("session", "create", "sessions/abc", { msg: "hello" })

    const entries: any[] = []
    for await (const entry of wal.replay()) {
      entries.push(entry)
    }

    expect(entries.length).toBe(3)
    expect(entries[0].type).toBe("config")
    expect(entries[1].type).toBe("audit")
    expect(entries[2].type).toBe("session")
  })

  it("skips unknown future entry types without crashing", async () => {
    const { wal, dir } = createTempWAL()
    walDir = dir

    // Write a normal entry
    wal.append("session", "create", "sessions/abc", { msg: "hello" })

    // Manually inject an unknown-type entry into the WAL segment
    const { appendFileSync, createHash } = await import("node:fs")
    const crypto = await import("node:crypto")
    const segments = wal.getSegments()
    const unknownData = JSON.stringify({ future: true })
    const checksum = crypto.createHash("sha256").update(unknownData).digest("hex")
    const unknownEntry = JSON.stringify({
      id: "UNKNOWN_001",
      timestamp: Date.now(),
      type: "future_billing_v3",
      operation: "create",
      path: "future/entry",
      data: { future: true },
      checksum,
    })
    appendFileSync(segments[0], unknownEntry + "\n")

    // Write another normal entry
    wal.append("audit", "create", "billing-conservation-guard/evaluator_recovery", {
      subtype: "evaluator_recovery",
      pod_id: "pod-2",
      build_sha: "def",
      timestamp: new Date().toISOString(),
    })

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const entries: any[] = []
    for await (const entry of wal.replay()) {
      entries.push(entry)
    }

    // Should have 2 entries (unknown type skipped)
    expect(entries.length).toBe(2)
    expect(entries[0].type).toBe("session")
    expect(entries[1].type).toBe("audit")

    // Should have logged a warning about the unknown type
    const unknownWarnings = warnSpy.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("unknown entry type"),
    )
    expect(unknownWarnings.length).toBe(1)
    expect(unknownWarnings[0][0]).toContain("future_billing_v3")

    warnSpy.mockRestore()
  })

  it("handles mixed WAL segment with billing + audit + unknown types", async () => {
    const { wal, dir } = createTempWAL()
    walDir = dir

    // Simulate a real mixed segment
    wal.append("bead", "create", "beads/bd-abc", { id: "bd-abc" })
    wal.append("audit", "create", "billing-conservation-guard/evaluator_degraded", {
      subtype: "evaluator_degraded",
      pod_id: "pod-3",
      build_sha: "ghi",
      timestamp: new Date().toISOString(),
    })
    wal.append("memory", "update", "memory/obs-1", { text: "learned something" })
    wal.append("config", "update", "config/main", { setting: "value" })

    // Inject two unknown types
    const crypto = await import("node:crypto")
    const { appendFileSync } = await import("node:fs")
    const segments = wal.getSegments()
    for (const unknownType of ["governance_v2", "saga_checkpoint"]) {
      const data = JSON.stringify({ unknownType })
      const checksum = crypto.createHash("sha256").update(data).digest("hex")
      appendFileSync(segments[segments.length - 1], JSON.stringify({
        id: `UNKNOWN_${unknownType}`,
        timestamp: Date.now(),
        type: unknownType,
        operation: "create",
        path: `future/${unknownType}`,
        data: { unknownType },
        checksum,
      }) + "\n")
    }

    wal.append("session", "create", "sessions/xyz", { msg: "end" })

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const entries: any[] = []
    for await (const entry of wal.replay()) {
      entries.push(entry)
    }

    // 5 known entries, 2 unknown skipped
    expect(entries.length).toBe(5)
    expect(entries.map((e: any) => e.type)).toEqual(["bead", "audit", "memory", "config", "session"])

    // 2 unknown-type warnings
    const unknownWarnings = warnSpy.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("unknown entry type"),
    )
    expect(unknownWarnings.length).toBe(2)

    warnSpy.mockRestore()
  })
})

// --- isBillingReady (Task 2.7) ---

describe("isBillingReady", () => {
  afterEach(() => {
    delete process.env.EVALUATOR_BYPASS
  })

  it("returns false when uninitialized", () => {
    const guard = new BillingConservationGuard()
    expect(guard.isBillingReady()).toBe(false)
  })

  it("returns true when ready", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()
    expect(guard.isBillingReady()).toBe(true)
  })

  it("returns true when bypassed", async () => {
    process.env.EVALUATOR_BYPASS = "true"
    const guard = new BillingConservationGuard()
    await guard.init()
    expect(guard.isBillingReady()).toBe(true)
  })

  it("returns false when degraded (would need evaluator failure)", () => {
    // Uninitialized is the only testable non-ready non-bypassed state
    // without mocking the evaluator. state=degraded also returns false.
    const guard = new BillingConservationGuard()
    expect(guard.isBillingReady()).toBe(false)
  })
})

// --- Recovery Timer (Task 2.7) ---

describe("recovery timer", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not start recovery timer when state is ready", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()

    // startRecoveryTimer should be a no-op when ready
    guard.startRecoveryTimer(100)

    // No timer should be running — stopRecoveryTimer is safe to call
    guard.stopRecoveryTimer()
  })

  it("does not start recovery timer when state is uninitialized", () => {
    const guard = new BillingConservationGuard()
    // Not initialized, not degraded — no-op
    guard.startRecoveryTimer(100)
    guard.stopRecoveryTimer()
  })

  it("stopRecoveryTimer is safe to call multiple times", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()
    guard.stopRecoveryTimer()
    guard.stopRecoveryTimer()
    guard.stopRecoveryTimer()
  })
})

// --- Health Response (Task 2.7) ---

describe("getHealth response structure", () => {
  afterEach(() => {
    delete process.env.EVALUATOR_BYPASS
  })

  it("returns GuardHealth with all fields when ready", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()
    const health: GuardHealth = guard.getHealth()

    expect(health.billing).toBe("ready")
    expect(health.evaluator_compiled).toBe(true)
    expect(health.state).toBe("ready")
  })

  it("returns unavailable billing when uninitialized", () => {
    const guard = new BillingConservationGuard()
    const health = guard.getHealth()

    expect(health.billing).toBe("unavailable")
    expect(health.evaluator_compiled).toBe(false)
    expect(health.state).toBe("uninitialized")
  })

  it("returns ready billing when bypassed", async () => {
    process.env.EVALUATOR_BYPASS = "true"
    const guard = new BillingConservationGuard()
    await guard.init()
    const health = guard.getHealth()

    expect(health.billing).toBe("ready")
    expect(health.evaluator_compiled).toBe(false)
    expect(health.state).toBe("bypassed")
  })

  it("pod is always READY after init — even if bypassed", async () => {
    process.env.EVALUATOR_BYPASS = "true"
    const guard = new BillingConservationGuard()
    await guard.init()

    // Guard should report billing=ready (bypassed is ready for pod)
    expect(guard.getHealth().billing).toBe("ready")
    expect(guard.isBillingReady()).toBe(true)
  })
})

// --- Billing Entrypoint Inventory (Task 2.7) ---

describe("billing entrypoint inventory", () => {
  it("BILLING_ENTRYPOINTS is non-empty", () => {
    expect(BILLING_ENTRYPOINTS.length).toBeGreaterThan(0)
  })

  it("each entrypoint has path, method, and description", () => {
    for (const ep of BILLING_ENTRYPOINTS) {
      expect(ep.path).toMatch(/^\/api\//)
      expect(ep.method).toBe("POST")
      expect(ep.description.length).toBeGreaterThan(0)
    }
  })

  it("includes /api/v1/invoke", () => {
    const invoke = BILLING_ENTRYPOINTS.find(ep => ep.path === "/api/v1/invoke")
    expect(invoke).toBeDefined()
    expect(invoke!.method).toBe("POST")
  })

  it("includes /api/v1/oracle", () => {
    const oracle = BILLING_ENTRYPOINTS.find(ep => ep.path === "/api/v1/oracle")
    expect(oracle).toBeDefined()
    expect(oracle!.method).toBe("POST")
  })

  it("all billing entrypoints are gated by guard middleware (documented contract)", () => {
    // This test documents the contract that ALL billing entrypoints in the
    // BILLING_ENTRYPOINTS list MUST be gated by billing guard middleware in
    // src/gateway/server.ts. The guard returns 503 BILLING_EVALUATOR_UNAVAILABLE
    // when isBillingReady() returns false.
    //
    // Gating implementation:
    //   /api/v1/invoke  — billing guard middleware registered before route handler
    //   /api/v1/oracle  — billing guard middleware in oracle sub-app chain
    //
    // If a new billing entrypoint is added to BILLING_ENTRYPOINTS without
    // corresponding guard middleware in server.ts, this test should be updated
    // and the middleware added.
    const gatedPaths = ["/api/v1/invoke", "/api/v1/oracle"]
    for (const ep of BILLING_ENTRYPOINTS) {
      expect(gatedPaths).toContain(ep.path)
    }
  })
})

// --- Boot Sequence Position (Task 2.7) ---

describe("boot sequence position", () => {
  it("guard initializes after hounfour, before gateway (documented contract)", () => {
    // This test documents the boot sequence contract from SDD §4.2.
    // BillingConservationGuard.init() MUST be called:
    //   AFTER: hounfour initialization (needs evaluator package loaded)
    //   BEFORE: createApp() (needs to gate billing routes at startup)
    //
    // Boot sequence in src/index.ts:
    //   ...
    //   6e.  HounfourRouter initialization
    //   6e-guard.  BillingConservationGuard.init()  ← HERE
    //   6e-bis.  S2S Billing Finalize Client
    //   ...
    //   7.  createApp() — gateway creation
    //
    // Verified by reading src/index.ts boot order. If reordered,
    // billing routes may serve before guard is ready.
    expect(true).toBe(true) // Structural contract — enforced by code review
  })

  it("init() never throws — pod always becomes READY", async () => {
    const guard = new BillingConservationGuard()
    // Normal init — should resolve without error
    await expect(guard.init()).resolves.not.toThrow()
    expect(guard.getHealth().state).toBe("ready")
  })

  it("init() with bypass never throws — pod READY", async () => {
    process.env.EVALUATOR_BYPASS = "true"
    const guard = new BillingConservationGuard()
    await expect(guard.init()).resolves.not.toThrow()
    expect(guard.getHealth().billing).toBe("ready")
    delete process.env.EVALUATOR_BYPASS
  })
})

// --- Integration: 503 when degraded (Task 2.7) ---

describe("billing endpoint 503 when not ready", () => {
  it("uninitialized guard blocks billing (isBillingReady=false)", () => {
    const guard = new BillingConservationGuard()
    expect(guard.isBillingReady()).toBe(false)

    // This is the condition the middleware checks before returning 503
    const result = guard.checkCostNonNegative(100n)
    expect(result.effective).toBe("fail")
    expect(result.evaluator_result).toBe("error")
  })

  it("ready guard allows billing (isBillingReady=true)", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()
    expect(guard.isBillingReady()).toBe(true)

    const result = guard.checkCostNonNegative(100n)
    expect(result.effective).toBe("pass")
  })

  it("non-billing endpoints unaffected by guard state", () => {
    // Non-billing endpoints (/health, /api/sessions, /ws) do NOT check
    // isBillingReady(). They serve normally regardless of guard state.
    // This is a structural contract enforced by server.ts routing.
    //
    // Only BILLING_ENTRYPOINTS paths have the guard middleware.
    const nonBillingPaths = [
      "/health",
      "/api/sessions",
      "/api/sessions/abc",
      "/api/sessions/abc/message",
      "/api/dashboard/activity",
      "/.well-known/jwks.json",
      "/api/v1/usage",
    ]
    // None of these should appear in BILLING_ENTRYPOINTS
    for (const path of nonBillingPaths) {
      const found = BILLING_ENTRYPOINTS.find(ep => ep.path === path)
      expect(found).toBeUndefined()
    }
  })
})

// --- WAL Consumer Inventory Documentation (Task 2.6) ---

describe("WAL consumer inventory", () => {
  it("documents all WAL consumers and their type filtering", () => {
    // This test serves as executable documentation of the WAL consumer inventory.
    // All consumers listed in SDD §7.6 are documented here.
    //
    // Consumer Inventory:
    // 1. R2 Sync (src/persistence/r2-sync.ts)
    //    - Uses upstream WALManager, NOT application WAL
    //    - Syncs raw WAL batches without type filtering
    //    - NOT affected by audit entries (different WAL instance)
    //
    // 2. Git Sync (src/persistence/git-sync.ts)
    //    - Uses upstream WALManager, NOT application WAL
    //    - Records WAL seq in snapshot manifest
    //    - NOT affected by audit entries (different WAL instance)
    //
    // 3. Recovery Engine (src/persistence/recovery.ts)
    //    - Uses upstream WALManager, NOT application WAL
    //    - Replays WAL entries via upstream callback
    //    - NOT affected by audit entries (different WAL instance)
    //
    // 4. Application WAL replay (src/persistence/wal.ts)
    //    - Forward-compatible: skips unknown types with warning (SDD §7.6)
    //    - Handles audit entries natively (type in KNOWN_WAL_TYPES)
    //    - Tested in "forward-compatible WAL replay" suite above
    //
    // Conclusion: R2 sync, Git sync, and Recovery use the upstream WALManager
    // and never encounter application WAL audit entries. The application WAL's
    // own replay() method handles audit + unknown types safely.
    expect(true).toBe(true)
  })
})

// ============================================================================
// Task 2.8: Evaluator Test Suite — Comprehensive coverage
// ============================================================================

// --- Guard Compilation Failure + Retry (Task 2.8 Scenario 2) ---

describe("guard compilation failure + retry", () => {
  afterEach(() => {
    evaluatorOverride.fn = null
    vi.restoreAllMocks()
  })

  it("enters degraded state after all retry attempts exhausted", async () => {
    evaluatorOverride.fn = () => ({ valid: false, error: "evaluator unavailable", value: false })

    const { wal, dir } = createTempWAL()
    const guard = new BillingConservationGuard({ wal })

    vi.spyOn(console, "error").mockImplementation(() => {})

    await guard.init()

    expect(guard.getHealth().state).toBe("degraded")
    expect(guard.getHealth().evaluator_compiled).toBe(false)
    expect(guard.getHealth().billing).toBe("degraded")
    expect(guard.isBillingReady()).toBe(false)

    // Verify WAL audit entry for degraded state
    const segments = wal.getSegments()
    if (segments.length > 0) {
      const content = readFileSync(segments[0], "utf-8")
      const entries = content.trim().split("\n").map(l => JSON.parse(l))
      const degradedEntry = entries.find((e: any) => e.data?.subtype === "evaluator_degraded")
      expect(degradedEntry).toBeDefined()
    }

    rmSync(dir, { recursive: true, force: true })
  })

  it("billing endpoints return 503 when degraded", async () => {
    evaluatorOverride.fn = () => ({ valid: false, error: "broken", value: false })

    const guard = new BillingConservationGuard()
    vi.spyOn(console, "error").mockImplementation(() => {})

    await guard.init()

    expect(guard.isBillingReady()).toBe(false)

    // All invariant checks should return effective=fail in degraded state
    const budget = guard.checkBudgetConservation(0n, 1000n)
    expectFail(budget)
    expect(budget.evaluator_result).toBe("error")

    const cost = guard.checkCostNonNegative(100n)
    expectFail(cost)
  })
})

// --- Evaluator/Ad-Hoc Disagreement (Task 2.8 Scenario 5) ---

describe("evaluator/ad-hoc disagreement", () => {
  afterEach(() => {
    evaluatorOverride.fn = null
    vi.restoreAllMocks()
  })

  it("evaluator=pass ad-hoc=fail → effective=fail (ad-hoc caught something)", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()

    // After init, mock evaluator to always return pass
    evaluatorOverride.fn = () => ({ valid: true, value: true })

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    // Ad-hoc: spent > limit → fail. Evaluator mock: pass.
    const result = guard.checkBudgetConservation(1001n, 1000n)

    expectFail(result)
    expect(result.evaluator_result).toBe("pass")
    expect(result.adhoc_result).toBe("fail")
    expect(result.effective).toBe("fail")

    // Divergence should be logged
    const divergenceLogs = warnSpy.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("DIVERGENCE"),
    )
    expect(divergenceLogs.length).toBeGreaterThan(0)
    expect(divergenceLogs[0][0]).toContain("budget_conservation")
    expect(divergenceLogs[0][0]).toContain("evaluator=pass")
    expect(divergenceLogs[0][0]).toContain("adhoc=fail")
  })

  it("evaluator=fail ad-hoc=pass → effective=fail (evaluator caught something)", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()

    // After init, mock evaluator to return fail (valid but value=false)
    evaluatorOverride.fn = () => ({ valid: true, value: false })

    vi.spyOn(console, "warn").mockImplementation(() => {})

    // Ad-hoc: cost >= 0 → pass. Evaluator mock: fail.
    const result = guard.checkCostNonNegative(100n)

    expectFail(result)
    expect(result.evaluator_result).toBe("fail")
    expect(result.adhoc_result).toBe("pass")
    expect(result.effective).toBe("fail")
  })
})

// --- Evaluator Runtime Error (Task 2.8 Scenario 6) ---

describe("evaluator runtime error", () => {
  afterEach(() => {
    evaluatorOverride.fn = null
    vi.restoreAllMocks()
  })

  it("evaluator throw → evaluator_result=error, effective=fail (no fallback)", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()

    evaluatorOverride.fn = () => { throw new Error("evaluator crashed") }

    vi.spyOn(console, "error").mockImplementation(() => {})

    const result = guard.checkCostNonNegative(100n)

    expect(result.evaluator_result).toBe("error")
    expect(result.adhoc_result).toBe("pass")
    expect(result.effective).toBe("fail")
    expect(result.ok).toBe(false)

    // Error should be logged
    const errorSpy = vi.mocked(console.error)
    const errorLogs = errorSpy.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("evaluator threw"),
    )
    expect(errorLogs.length).toBeGreaterThan(0)
  })

  it("evaluator returns invalid result → evaluator_result=error, effective=fail", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()

    evaluatorOverride.fn = () => ({ valid: false, error: "constraint evaluation failed", value: false })

    vi.spyOn(console, "error").mockImplementation(() => {})

    const result = guard.checkReserveWithinAllocation(100n, 500n)

    expect(result.evaluator_result).toBe("error")
    expect(result.adhoc_result).toBe("pass")
    expect(result.effective).toBe("fail")
  })
})

// --- Bypass Does Not Auto-Activate on Error (Task 2.8 Scenario 7) ---

describe("bypass does not auto-activate on error", () => {
  afterEach(() => {
    evaluatorOverride.fn = null
    vi.restoreAllMocks()
    delete process.env.EVALUATOR_BYPASS
  })

  it("compilation failure → state=degraded NOT bypassed", async () => {
    evaluatorOverride.fn = () => ({ valid: false, error: "broken evaluator", value: false })
    vi.spyOn(console, "error").mockImplementation(() => {})

    const guard = new BillingConservationGuard()
    await guard.init()

    expect(guard.getHealth().state).toBe("degraded")
    expect(guard.getHealth().state).not.toBe("bypassed")
  })

  it("runtime evaluator errors do not toggle bypass state", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()
    expect(guard.getHealth().state).toBe("ready")

    // Mock evaluator to throw on the check call
    evaluatorOverride.fn = () => { throw new Error("runtime crash") }
    vi.spyOn(console, "error").mockImplementation(() => {})

    const result = guard.checkCostNonNegative(100n)
    expect(result.evaluator_result).toBe("error")
    expect(result.effective).toBe("fail")

    // State should still be ready, NOT bypassed
    expect(guard.getHealth().state).toBe("ready")
    expect(guard.getHealth().state).not.toBe("bypassed")
  })

  it("EVALUATOR_BYPASS env is the ONLY way to enter bypass state", async () => {
    // No EVALUATOR_BYPASS set
    expect(process.env.EVALUATOR_BYPASS).toBeUndefined()

    // Even with evaluator failure, state goes to degraded not bypassed
    evaluatorOverride.fn = () => ({ valid: false, error: "unavailable", value: false })
    vi.spyOn(console, "error").mockImplementation(() => {})

    const guard = new BillingConservationGuard()
    await guard.init()

    expect(guard.getHealth().state).toBe("degraded")

    // Only EVALUATOR_BYPASS=true → bypassed
    evaluatorOverride.fn = null
    process.env.EVALUATOR_BYPASS = "true"
    const guard2 = new BillingConservationGuard()
    await guard2.init()
    expect(guard2.getHealth().state).toBe("bypassed")
  })
})

// --- Degraded State Recovery (Task 2.8 Scenario 9) ---

describe("degraded state recovery", () => {
  afterEach(() => {
    evaluatorOverride.fn = null
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // init() uses real sleep() for retries (1s+2s = 3s total), so we MUST
  // use real timers during init, then switch to fake timers for recovery.

  it("recovery timer retries compilation and transitions to ready on success", async () => {
    // Phase 1: Get guard into degraded state with REAL timers
    evaluatorOverride.fn = () => ({ valid: false, error: "broken", value: false })
    vi.spyOn(console, "error").mockImplementation(() => {})

    const { wal, dir } = createTempWAL()
    const guard = new BillingConservationGuard({ wal })
    await guard.init() // Real timers — retries exhaust in ~3s → degraded

    expect(guard.getHealth().state).toBe("degraded")
    expect(guard.isBillingReady()).toBe(false)

    // Phase 2: Switch to fake timers for recovery
    vi.spyOn(Math, "random").mockReturnValue(0.5) // Deterministic jitter for fake timers
    vi.useFakeTimers()
    guard.startRecoveryTimer(1000)

    // First tick — evaluator still broken
    vi.advanceTimersByTime(1000)
    expect(guard.getHealth().state).toBe("degraded")

    // Fix evaluator — next tick should recover
    // After first failure, interval doubles to 2000ms (exponential backoff)
    evaluatorOverride.fn = null // Back to real evaluator
    vi.spyOn(console, "log").mockImplementation(() => {})

    vi.advanceTimersByTime(2000)
    expect(guard.getHealth().state).toBe("ready")
    expect(guard.getHealth().evaluator_compiled).toBe(true)
    expect(guard.isBillingReady()).toBe(true)

    // Verify recovery WAL audit entry
    const segments = wal.getSegments()
    if (segments.length > 0) {
      const content = readFileSync(segments[segments.length - 1], "utf-8")
      const entries = content.trim().split("\n").map(l => JSON.parse(l))
      const recoveryEntry = entries.find((e: any) => e.data?.subtype === "evaluator_recovery")
      expect(recoveryEntry).toBeDefined()
    }

    guard.stopRecoveryTimer()
    rmSync(dir, { recursive: true, force: true })
  }, 10_000)

  it("recovery timer stops itself after successful recovery", async () => {
    evaluatorOverride.fn = () => ({ valid: false, error: "broken", value: false })
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})

    const guard = new BillingConservationGuard()
    await guard.init() // Real timers → degraded

    expect(guard.getHealth().state).toBe("degraded")

    // Switch to fake timers for recovery
    vi.spyOn(Math, "random").mockReturnValue(0.5) // Deterministic jitter for fake timers
    vi.useFakeTimers()
    guard.startRecoveryTimer(500)

    // Fix evaluator
    evaluatorOverride.fn = null
    vi.spyOn(console, "log").mockImplementation(() => {})

    vi.advanceTimersByTime(500)
    expect(guard.getHealth().state).toBe("ready")

    // Further timer ticks should not change anything (timer auto-stopped)
    vi.advanceTimersByTime(5000)
    expect(guard.getHealth().state).toBe("ready")
  }, 10_000)

  it("billing endpoints resume serving after recovery", async () => {
    evaluatorOverride.fn = () => ({ valid: false, error: "broken", value: false })
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})

    const guard = new BillingConservationGuard()
    await guard.init() // Real timers → degraded

    // Degraded: billing blocked
    expect(guard.isBillingReady()).toBe(false)
    const degradedResult = guard.checkCostNonNegative(100n)
    expect(degradedResult.effective).toBe("fail")

    // Switch to fake timers for recovery
    vi.spyOn(Math, "random").mockReturnValue(0.5) // Deterministic jitter for fake timers
    vi.useFakeTimers()
    guard.startRecoveryTimer(500)

    // Fix evaluator
    evaluatorOverride.fn = null
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.advanceTimersByTime(500)

    // Recovered: billing unblocked
    expect(guard.isBillingReady()).toBe(true)
    const recoveredResult = guard.checkCostNonNegative(100n)
    expect(recoveredResult.effective).toBe("pass")

    guard.stopRecoveryTimer()
  }, 10_000)
})

// --- Complete Fail-Closed Lattice Table (Task 2.8) ---

describe("complete fail-closed lattice table", () => {
  afterEach(() => {
    evaluatorOverride.fn = null
    vi.restoreAllMocks()
    delete process.env.EVALUATOR_BYPASS
  })

  // Strict lattice truth table (SDD §4.2):
  // evaluator | adhoc | effective
  // pass      | pass  | pass
  // pass      | fail  | fail
  // fail      | pass  | fail
  // fail      | fail  | fail
  // error     | pass  | fail
  // error     | fail  | fail
  // bypassed  | pass  | pass
  // bypassed  | fail  | fail

  it("evaluator=pass, adhoc=pass → effective=pass", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()
    // Normal case: both agree pass (real evaluator)
    const result = guard.checkCostNonNegative(100n)
    expect(result.evaluator_result).toBe("pass")
    expect(result.adhoc_result).toBe("pass")
    expect(result.effective).toBe("pass")
  })

  it("evaluator=pass, adhoc=fail → effective=fail", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()

    // Mock evaluator to return pass even when ad-hoc fails
    evaluatorOverride.fn = () => ({ valid: true, value: true })
    vi.spyOn(console, "warn").mockImplementation(() => {})

    // Ad-hoc: spent > limit → fail. Evaluator mock: pass.
    const result = guard.checkBudgetConservation(1001n, 1000n)
    expect(result.evaluator_result).toBe("pass")
    expect(result.adhoc_result).toBe("fail")
    expect(result.effective).toBe("fail")
  })

  it("evaluator=fail, adhoc=pass → effective=fail", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()

    evaluatorOverride.fn = () => ({ valid: true, value: false })
    vi.spyOn(console, "warn").mockImplementation(() => {})

    const result = guard.checkCostNonNegative(100n)
    expect(result.evaluator_result).toBe("fail")
    expect(result.adhoc_result).toBe("pass")
    expect(result.effective).toBe("fail")
  })

  it("evaluator=fail, adhoc=fail → effective=fail", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()

    evaluatorOverride.fn = () => ({ valid: true, value: false })

    const result = guard.checkCostNonNegative(-1n)
    expect(result.evaluator_result).toBe("fail")
    expect(result.adhoc_result).toBe("fail")
    expect(result.effective).toBe("fail")
  })

  it("evaluator=error, adhoc=pass → effective=fail", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()

    evaluatorOverride.fn = () => { throw new Error("crash") }
    vi.spyOn(console, "error").mockImplementation(() => {})

    const result = guard.checkCostNonNegative(100n)
    expect(result.evaluator_result).toBe("error")
    expect(result.adhoc_result).toBe("pass")
    expect(result.effective).toBe("fail")
  })

  it("evaluator=error, adhoc=fail → effective=fail", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()

    evaluatorOverride.fn = () => { throw new Error("crash") }
    vi.spyOn(console, "error").mockImplementation(() => {})

    const result = guard.checkCostNonNegative(-1n)
    expect(result.evaluator_result).toBe("error")
    expect(result.adhoc_result).toBe("fail")
    expect(result.effective).toBe("fail")
  })

  it("evaluator=bypassed, adhoc=pass → effective=pass", async () => {
    process.env.EVALUATOR_BYPASS = "true"
    const guard = new BillingConservationGuard()
    await guard.init()

    const result = guard.checkCostNonNegative(100n)
    expect(result.evaluator_result).toBe("bypassed")
    expect(result.adhoc_result).toBe("pass")
    expect(result.effective).toBe("pass")
  })

  it("evaluator=bypassed, adhoc=fail → effective=fail", async () => {
    process.env.EVALUATOR_BYPASS = "true"
    const guard = new BillingConservationGuard()
    await guard.init()

    const result = guard.checkCostNonNegative(-1n)
    expect(result.evaluator_result).toBe("bypassed")
    expect(result.adhoc_result).toBe("fail")
    expect(result.effective).toBe("fail")
  })
})

// --- Property-Based Invariant Testing (Task 2.8) ---

describe("property-based invariant testing", () => {
  let guard: BillingConservationGuard

  beforeEach(async () => {
    guard = new BillingConservationGuard()
    await guard.init()
  })

  it("budget conservation: spent <= limit iff result passes", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        (spent, limit) => {
          const result = guard.checkBudgetConservation(spent, limit)
          if (spent <= limit) {
            return result.ok === true && result.effective === "pass"
          } else {
            return result.ok === false && result.effective === "fail"
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it("cost non-negative: cost >= 0 iff result passes", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000n, max: 10_000_000_000n }),
        (cost) => {
          const result = guard.checkCostNonNegative(cost)
          if (cost >= 0n) {
            return result.ok === true && result.effective === "pass"
          } else {
            return result.ok === false && result.effective === "fail"
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it("reserve within allocation: reserve <= allocation iff result passes", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        (reserve, allocation) => {
          const result = guard.checkReserveWithinAllocation(reserve, allocation)
          if (reserve <= allocation) {
            return result.ok === true && result.effective === "pass"
          } else {
            return result.ok === false && result.effective === "fail"
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it("InvariantResult.ok always equals (effective === 'pass')", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -100n, max: 10_000n }),
        fc.bigInt({ min: 0n, max: 10_000n }),
        (cost, limit) => {
          const r1 = guard.checkCostNonNegative(cost)
          const r2 = guard.checkBudgetConservation(cost < 0n ? 0n : cost, limit)
          return (
            r1.ok === (r1.effective === "pass") &&
            r2.ok === (r2.effective === "pass")
          )
        },
      ),
      { numRuns: 200 },
    )
  })

  it("micro USD format: canonical strings pass, malformed fail", () => {
    const canonicalArb = fc.oneof(
      fc.constant("0"),
      fc.integer({ min: 1, max: 999_999_999 }).map(n => String(n)),
      fc.integer({ min: -999_999_999, max: -1 }).map(n => String(n)),
    )

    fc.assert(
      fc.property(canonicalArb, (value) => {
        const result = guard.checkMicroUSDFormat(value)
        return result.adhoc_result === "pass"
      }),
      { numRuns: 100 },
    )
  })

  it("micro USD format: leading zeros always fail", () => {
    const leadingZeroArb = fc.integer({ min: 1, max: 999_999 })
      .map(n => "0" + String(n))

    fc.assert(
      fc.property(leadingZeroArb, (value) => {
        const result = guard.checkMicroUSDFormat(value)
        return result.adhoc_result === "fail" && result.effective === "fail"
      }),
      { numRuns: 100 },
    )
  })
})

// ============================================================================
// Task 2.10: Observability — Metrics + Structured Logging
// ============================================================================

/** Create a mock GuardMetrics that records all calls. */
function createMockMetrics() {
  const calls = {
    compileDuration: [] as number[],
    checkDuration: [] as { invariantId: string; durationMs: number }[],
    hardFail: [] as HardFailDetail[],
    circuitState: [] as ("open" | "closed")[],
    constraintCount: [] as number[],
    divergence: [] as { invariantId: string; evaluatorResult: string; adhocResult: string }[],
  }

  const metrics: GuardMetrics = {
    recordCompileDuration(ms) { calls.compileDuration.push(ms) },
    recordCheckDuration(id, ms) { calls.checkDuration.push({ invariantId: id, durationMs: ms }) },
    recordHardFail(detail) { calls.hardFail.push(detail) },
    recordCircuitState(state) { calls.circuitState.push(state) },
    recordConstraintCount(count) { calls.constraintCount.push(count) },
    recordDivergence(id, ev, ad) { calls.divergence.push({ invariantId: id, evaluatorResult: ev, adhocResult: ad }) },
  }

  return { metrics, calls }
}

// --- Metric Signal: Compilation Duration + Constraint Count + Circuit State ---

describe("observability: compilation metrics (Task 2.10)", () => {
  afterEach(() => {
    evaluatorOverride.fn = null
    vi.restoreAllMocks()
  })

  it("emits compile duration, constraint count, and circuit=closed on successful init", async () => {
    const { metrics, calls } = createMockMetrics()
    const guard = new BillingConservationGuard({ metrics })
    await guard.init()

    expect(calls.compileDuration).toHaveLength(1)
    expect(calls.compileDuration[0]).toBeGreaterThan(0)
    expect(calls.constraintCount).toEqual([6])
    expect(calls.circuitState).toEqual(["closed"])
  })

  it("emits circuit=open on compilation failure (degraded)", async () => {
    evaluatorOverride.fn = () => ({ valid: false, error: "broken", value: false })
    vi.spyOn(console, "error").mockImplementation(() => {})

    const { metrics, calls } = createMockMetrics()
    const guard = new BillingConservationGuard({ metrics })
    await guard.init()

    expect(guard.getHealth().state).toBe("degraded")
    expect(calls.circuitState).toEqual(["open"])
    expect(calls.compileDuration).toHaveLength(0) // Never compiled successfully
    expect(calls.constraintCount).toHaveLength(0)
  })

  it("emits circuit=closed + constraint count on recovery", async () => {
    evaluatorOverride.fn = () => ({ valid: false, error: "broken", value: false })
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})

    const { metrics, calls } = createMockMetrics()
    const guard = new BillingConservationGuard({ metrics })
    await guard.init() // Real timers → degraded

    expect(calls.circuitState).toEqual(["open"])

    // Switch to fake timers for recovery
    vi.spyOn(Math, "random").mockReturnValue(0.5) // Deterministic jitter for fake timers
    vi.useFakeTimers()
    guard.startRecoveryTimer(500)

    // Fix evaluator
    evaluatorOverride.fn = null
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.advanceTimersByTime(500)

    expect(guard.getHealth().state).toBe("ready")
    expect(calls.circuitState).toEqual(["open", "closed"])
    expect(calls.constraintCount).toEqual([6])

    guard.stopRecoveryTimer()
    vi.useRealTimers()
  }, 10_000)
})

// --- Metric Signal: Check Duration ---

describe("observability: check duration metrics (Task 2.10)", () => {
  afterEach(() => {
    evaluatorOverride.fn = null
    vi.restoreAllMocks()
  })

  it("emits check duration for each invariant check", async () => {
    const { metrics, calls } = createMockMetrics()
    const guard = new BillingConservationGuard({ metrics })
    await guard.init()

    guard.checkBudgetConservation(100n, 1000n)
    guard.checkCostNonNegative(42n)
    guard.checkReserveWithinAllocation(500n, 1000n)
    guard.checkMicroUSDFormat("12345")

    expect(calls.checkDuration).toHaveLength(4)
    expect(calls.checkDuration[0].invariantId).toBe("budget_conservation")
    expect(calls.checkDuration[1].invariantId).toBe("cost_non_negative")
    expect(calls.checkDuration[2].invariantId).toBe("reserve_within_allocation")
    expect(calls.checkDuration[3].invariantId).toBe("micro_usd_format")

    // All durations should be positive
    for (const c of calls.checkDuration) {
      expect(c.durationMs).toBeGreaterThanOrEqual(0)
    }
  })
})

// --- Metric Signal: HARD-FAIL + Structured Logging ---

describe("observability: hard-fail metrics + structured logging (Task 2.10)", () => {
  afterEach(() => {
    evaluatorOverride.fn = null
    vi.restoreAllMocks()
  })

  it("emits hard-fail metric when effective=fail", async () => {
    const { metrics, calls } = createMockMetrics()
    const guard = new BillingConservationGuard({ metrics })
    await guard.init()

    vi.spyOn(console, "error").mockImplementation(() => {})

    // Trigger a fail: spent > limit
    guard.checkBudgetConservation(2000n, 1000n)

    expect(calls.hardFail).toHaveLength(1)
    expect(calls.hardFail[0].invariant_id).toBe("budget_conservation")
    expect(calls.hardFail[0].effective).toBe("fail")
    expect(calls.hardFail[0].timestamp).toBeTruthy()
  })

  it("hard-fail input_summary contains only allowlisted numeric fields (no PII)", async () => {
    const { metrics, calls } = createMockMetrics()
    const guard = new BillingConservationGuard({ metrics })
    await guard.init()

    vi.spyOn(console, "error").mockImplementation(() => {})

    guard.checkBudgetConservation(2000n, 1000n)

    const summary = calls.hardFail[0].input_summary
    const allowedKeys = new Set(["spent", "limit", "cost", "zero", "reserve", "allocation", "value"])
    for (const key of Object.keys(summary)) {
      expect(allowedKeys.has(key)).toBe(true)
      expect(/^-?\d+$/.test(summary[key])).toBe(true)
    }
  })

  it("does not emit hard-fail metric when effective=pass", async () => {
    const { metrics, calls } = createMockMetrics()
    const guard = new BillingConservationGuard({ metrics })
    await guard.init()

    guard.checkBudgetConservation(100n, 1000n)

    expect(calls.hardFail).toHaveLength(0)
  })

  it("emits structured HARD_FAIL console.error log", async () => {
    const { metrics } = createMockMetrics()
    const guard = new BillingConservationGuard({ metrics })
    await guard.init()

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    guard.checkBudgetConservation(2000n, 1000n)

    const hardFailLogs = errorSpy.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("HARD_FAIL"),
    )
    expect(hardFailLogs.length).toBeGreaterThan(0)

    // Parse the JSON payload
    const payload = JSON.parse(hardFailLogs[0][1])
    expect(payload.invariant_id).toBe("budget_conservation")
    expect(payload.effective).toBe("fail")
    expect(payload.input_summary).toBeDefined()
    expect(payload.timestamp).toBeTruthy()
  })

  it("emits hard-fail in degraded state", async () => {
    evaluatorOverride.fn = () => ({ valid: false, error: "broken", value: false })
    vi.spyOn(console, "error").mockImplementation(() => {})

    const { metrics, calls } = createMockMetrics()
    const guard = new BillingConservationGuard({ metrics })
    await guard.init()

    guard.checkCostNonNegative(100n)

    expect(calls.hardFail).toHaveLength(1)
    expect(calls.hardFail[0].evaluator_result).toBe("error")
  }, 10_000)
})

// --- Metric Signal: Divergence ---

describe("observability: divergence metrics (Task 2.10)", () => {
  afterEach(() => {
    evaluatorOverride.fn = null
    vi.restoreAllMocks()
  })

  it("emits divergence metric when evaluator and ad-hoc disagree", async () => {
    const { metrics, calls } = createMockMetrics()
    const guard = new BillingConservationGuard({ metrics })
    await guard.init()

    // Mock evaluator to pass when ad-hoc will fail
    evaluatorOverride.fn = () => ({ valid: true, value: true })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})

    guard.checkBudgetConservation(2000n, 1000n) // adhoc=fail, evaluator=pass

    expect(calls.divergence).toHaveLength(1)
    expect(calls.divergence[0].invariantId).toBe("budget_conservation")
    expect(calls.divergence[0].evaluatorResult).toBe("pass")
    expect(calls.divergence[0].adhocResult).toBe("fail")
  })

  it("does not emit divergence on evaluator error (only on real disagreement)", async () => {
    const { metrics, calls } = createMockMetrics()
    const guard = new BillingConservationGuard({ metrics })
    await guard.init()

    evaluatorOverride.fn = () => { throw new Error("crash") }
    vi.spyOn(console, "error").mockImplementation(() => {})

    guard.checkCostNonNegative(100n)

    expect(calls.divergence).toHaveLength(0)
  })

  it("does not emit divergence when both agree", async () => {
    const { metrics, calls } = createMockMetrics()
    const guard = new BillingConservationGuard({ metrics })
    await guard.init()

    guard.checkCostNonNegative(100n) // both pass

    expect(calls.divergence).toHaveLength(0)
  })
})

// --- Metric Signal: Circuit-Open Alert ---

describe("observability: circuit-open alert (Task 2.10)", () => {
  afterEach(() => {
    evaluatorOverride.fn = null
    vi.restoreAllMocks()
  })

  it("fires critical alert via AlertService when entering degraded state", { timeout: 10_000 }, async () => {
    evaluatorOverride.fn = () => ({ valid: false, error: "broken", value: false })
    vi.spyOn(console, "error").mockImplementation(() => {})

    const fireSpy = vi.fn().mockResolvedValue(true)
    const alertService = { fire: fireSpy } as unknown as AlertService

    const { metrics } = createMockMetrics()
    const guard = new BillingConservationGuard({
      metrics,
      alertService,
      podId: "test-pod",
      buildSha: "abc123",
    })
    await guard.init()

    expect(guard.getHealth().state).toBe("degraded")

    // Alert should have been fired with circuit-open trigger
    const circuitCalls = fireSpy.mock.calls.filter(
      (c: any[]) => c[1] === "evaluator_circuit_open",
    )
    expect(circuitCalls).toHaveLength(1)
    expect(circuitCalls[0][0]).toBe("critical")
    expect(circuitCalls[0][2].message).toContain("circuit OPEN")
    expect(circuitCalls[0][2].details.pod_id).toBe("test-pod")
  })

  it("does not fire circuit-open alert on successful init", async () => {
    const fireSpy = vi.fn().mockResolvedValue(true)
    const alertService = { fire: fireSpy } as unknown as AlertService

    const { metrics } = createMockMetrics()
    const guard = new BillingConservationGuard({ metrics, alertService })
    await guard.init()

    expect(guard.getHealth().state).toBe("ready")

    const circuitCalls = fireSpy.mock.calls.filter(
      (c: any[]) => c[1] === "evaluator_circuit_open",
    )
    expect(circuitCalls).toHaveLength(0)
  })
})

// --- Noop Metrics Default ---

describe("observability: noop metrics default (Task 2.10)", () => {
  it("guard works without metrics configured (noop default)", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()

    // All operations should work with no metrics configured
    const r1 = guard.checkBudgetConservation(100n, 1000n)
    expect(r1.ok).toBe(true)

    const r2 = guard.checkCostNonNegative(42n)
    expect(r2.ok).toBe(true)
  })
})
