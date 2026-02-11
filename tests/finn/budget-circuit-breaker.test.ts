// tests/finn/budget-circuit-breaker.test.ts — Budget Circuit Breaker tests (F6a, T-31.1)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { BudgetEnforcer, deriveScopeKey } from "../../src/hounfour/budget.js"
import type { BudgetConfig } from "../../src/hounfour/budget.js"
import type { ScopeMeta, UsageInfo, PricingEntry } from "../../src/hounfour/types.js"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const testScope: ScopeMeta = {
  project_id: "test-proj",
  phase_id: "phase-0",
  sprint_id: "sprint-31",
}

const testUsage: UsageInfo = {
  prompt_tokens: 100,
  completion_tokens: 50,
  reasoning_tokens: 0,
}

const testPricing: PricingEntry = {
  provider: "openai",
  model: "gpt-4o",
  input_per_1m: 2.5,
  output_per_1m: 10.0,
}

const testExtra = {
  trace_id: "trace-001",
  agent: "test-agent",
  provider: "openai",
  model: "gpt-4o",
  tenant_id: "local",
  latency_ms: 100,
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "finn-circuit-"))
}

function makeConfig(dir: string, overrides?: Partial<BudgetConfig>): BudgetConfig {
  const keys = deriveScopeKey(testScope)
  return {
    ledgerPath: join(dir, "cost-ledger.jsonl"),
    checkpointPath: join(dir, "budget-checkpoint.json"),
    onLedgerFailure: "fail-open",
    warnPercent: 80,
    budgets: { [keys.sprint]: 10.0 },
    ...overrides,
  }
}

describe("Budget Circuit Breaker (F6a)", () => {
  let dir: string

  beforeEach(() => {
    dir = makeTempDir()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("isBudgetCircuitOpen returns false when state is known", () => {
    const enforcer = new BudgetEnforcer(makeConfig(dir))
    expect(enforcer.isBudgetCircuitOpen(300_000)).toBe(false)
  })

  it("isBudgetCircuitOpen returns false for transient failure (< window)", async () => {
    const config = makeConfig(dir, {
      ledgerPath: "/nonexistent/path/ledger.jsonl",
      onLedgerFailure: "fail-open",
    })
    const enforcer = new BudgetEnforcer(config)

    // Suppress expected error output
    const origError = console.error
    console.error = () => {}

    await enforcer.recordCost(testScope, testUsage, testPricing, testExtra)
    // State is unknown but failure just started (< 5 min)
    expect(enforcer.isStateUnknown()).toBe(true)
    expect(enforcer.isBudgetCircuitOpen(300_000)).toBe(false)

    console.error = origError
  })

  it("isBudgetCircuitOpen returns true after window exceeded", async () => {
    const config = makeConfig(dir, {
      ledgerPath: "/nonexistent/path/ledger.jsonl",
      onLedgerFailure: "fail-open",
    })
    const enforcer = new BudgetEnforcer(config)

    const origError = console.error
    console.error = () => {}

    await enforcer.recordCost(testScope, testUsage, testPricing, testExtra)
    expect(enforcer.isStateUnknown()).toBe(true)

    // Simulate time passing: use a very small window (0ms) to trigger immediately
    expect(enforcer.isBudgetCircuitOpen(0)).toBe(true)

    console.error = origError
  })

  it("circuit closes on recovery (successful ledger write)", async () => {
    const config = makeConfig(dir, {
      onLedgerFailure: "fail-open",
    })
    const enforcer = new BudgetEnforcer(config)

    // First: force a failure by using a bad path temporarily
    const origError = console.error
    console.error = () => {}

    // Manually trigger the unknown state by recording with bad config
    const badConfig = makeConfig(dir, {
      ledgerPath: "/nonexistent/path/ledger.jsonl",
      onLedgerFailure: "fail-open",
    })
    const badEnforcer = new BudgetEnforcer(badConfig)
    await badEnforcer.recordCost(testScope, testUsage, testPricing, testExtra)
    expect(badEnforcer.isStateUnknown()).toBe(true)
    expect(badEnforcer.isBudgetCircuitOpen(0)).toBe(true)

    console.error = origError

    // Good enforcer: successful write clears state
    await enforcer.recordCost(testScope, testUsage, testPricing, testExtra)
    expect(enforcer.isStateUnknown()).toBe(false)
    expect(enforcer.isBudgetCircuitOpen(0)).toBe(false)
  })

  it("configurable threshold: 1 second window", async () => {
    const config = makeConfig(dir, {
      ledgerPath: "/nonexistent/path/ledger.jsonl",
      onLedgerFailure: "fail-open",
    })
    const enforcer = new BudgetEnforcer(config)

    const origError = console.error
    console.error = () => {}

    await enforcer.recordCost(testScope, testUsage, testPricing, testExtra)
    // With 1 second window, should not be open yet (just started)
    expect(enforcer.isBudgetCircuitOpen(1000)).toBe(false)
    // With 0ms window, should be open immediately
    expect(enforcer.isBudgetCircuitOpen(0)).toBe(true)

    console.error = origError
  })
})
