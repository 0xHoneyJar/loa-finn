// tests/finn/hounfour-budget.test.ts — Cost Ledger & Budget Enforcer tests (T-14.7)

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BudgetEnforcer, deriveScopeKey, calculateCost } from "../../src/hounfour/budget.js"
import type { BudgetConfig } from "../../src/hounfour/budget.js"
import type { UsageInfo, PricingEntry, ScopeMeta } from "../../src/hounfour/types.js"

const PREFIX = "finn-budget-test-"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), PREFIX))
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

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

const testScope: ScopeMeta = {
  project_id: "loa-finn",
  phase_id: "phase-0",
  sprint_id: "sprint-14",
}

const testUsage: UsageInfo = {
  prompt_tokens: 1000,
  completion_tokens: 500,
  reasoning_tokens: 0,
}

const testPricing: PricingEntry = {
  provider: "openai",
  model: "gpt-4o",
  input_per_1m: 2.5,
  output_per_1m: 10.0,
}

const testExtra = {
  trace_id: "abc-123",
  agent: "reviewing-code",
  provider: "openai",
  model: "gpt-4o",
  tenant_id: "local",
  latency_ms: 1200,
}

function makeConfig(dir: string, overrides?: Partial<BudgetConfig>): BudgetConfig {
  const keys = deriveScopeKey(testScope)
  return {
    ledgerPath: join(dir, "cost-ledger.jsonl"),
    checkpointPath: join(dir, "budget-checkpoint.json"),
    onLedgerFailure: "fail-open",
    warnPercent: 80,
    budgets: {
      [keys.sprint]: 1.0,  // $1.00 budget for sprint
    },
    ...overrides,
  }
}

async function main() {
  console.log("Cost Ledger & Budget Enforcer Tests (T-14.7)")
  console.log("=============================================")

  // --- deriveScopeKey ---

  await test("deriveScopeKey produces consistent keys", () => {
    const keys = deriveScopeKey(testScope)
    assert.equal(keys.project, "project:loa-finn")
    assert.equal(keys.phase, "project:loa-finn:phase:phase-0")
    assert.equal(keys.sprint, "project:loa-finn:phase:phase-0:sprint:sprint-14")
  })

  await test("deriveScopeKey produces different keys for different scopes", () => {
    const keys1 = deriveScopeKey({ project_id: "a", phase_id: "b", sprint_id: "c" })
    const keys2 = deriveScopeKey({ project_id: "a", phase_id: "b", sprint_id: "d" })
    assert.notEqual(keys1.sprint, keys2.sprint)
    assert.equal(keys1.phase, keys2.phase)
    assert.equal(keys1.project, keys2.project)
  })

  // --- calculateCost ---

  await test("calculateCost computes correct cost for API pricing", () => {
    const cost = calculateCost(testUsage, testPricing)
    // input: (1000 * 2.5) / 1M = 0.0025
    // output: (500 * 10.0) / 1M = 0.005
    const expected = 0.0025 + 0.005
    assert.equal(cost, expected)
  })

  await test("calculateCost includes reasoning tokens when priced", () => {
    const usage: UsageInfo = { prompt_tokens: 1000, completion_tokens: 500, reasoning_tokens: 200 }
    const pricing: PricingEntry = {
      provider: "moonshot",
      model: "kimi-k2",
      input_per_1m: 1.0,
      output_per_1m: 4.0,
      reasoning_per_1m: 2.0,
    }
    const cost = calculateCost(usage, pricing)
    // input: (1000 * 1.0) / 1M = 0.001
    // output: (500 * 4.0) / 1M = 0.002
    // reasoning: (200 * 2.0) / 1M = 0.0004
    const expected = 0.001 + 0.002 + 0.0004
    assert.ok(Math.abs(cost - expected) < 1e-10)
  })

  await test("calculateCost returns 0 for zero tokens", () => {
    const usage: UsageInfo = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 }
    const cost = calculateCost(usage, testPricing)
    assert.equal(cost, 0)
  })

  // --- BudgetEnforcer recordCost ---

  await test("recordCost creates ledger file and writes JSONL entry", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig(dir)
      const enforcer = new BudgetEnforcer(config)
      await enforcer.recordCost(testScope, testUsage, testPricing, testExtra)

      assert.ok(existsSync(config.ledgerPath))
      const content = readFileSync(config.ledgerPath, "utf8")
      const lines = content.trim().split("\n")
      assert.equal(lines.length, 1)

      const entry = JSON.parse(lines[0])
      assert.equal(entry.trace_id, "abc-123")
      assert.equal(entry.agent, "reviewing-code")
      assert.equal(entry.provider, "openai")
      assert.equal(entry.model, "gpt-4o")
      assert.equal(entry.project_id, "loa-finn")
      assert.equal(entry.prompt_tokens, 1000)
      assert.equal(entry.completion_tokens, 500)
      assert.ok(entry.total_cost_usd > 0)
      assert.ok(entry.timestamp)
    } finally {
      cleanup(dir)
    }
  })

  await test("recordCost writes checkpoint file", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig(dir)
      const enforcer = new BudgetEnforcer(config)
      await enforcer.recordCost(testScope, testUsage, testPricing, testExtra)

      assert.ok(existsSync(config.checkpointPath))
      const checkpoint = JSON.parse(readFileSync(config.checkpointPath, "utf8"))
      assert.equal(checkpoint.schema_version, 1)
      assert.equal(checkpoint.ledger_head_line, 1)
      assert.ok(checkpoint.counters)
    } finally {
      cleanup(dir)
    }
  })

  await test("recordCost increments counters correctly", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig(dir)
      const enforcer = new BudgetEnforcer(config)

      await enforcer.recordCost(testScope, testUsage, testPricing, testExtra)
      await enforcer.recordCost(testScope, testUsage, testPricing, testExtra)

      const snapshot = enforcer.getBudgetSnapshot(testScope)
      const expectedCost = calculateCost(testUsage, testPricing) * 2
      assert.ok(Math.abs(snapshot.spent_usd - expectedCost) < 1e-10)
    } finally {
      cleanup(dir)
    }
  })

  await test("ledger has all 16 fields per entry", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig(dir)
      const enforcer = new BudgetEnforcer(config)
      await enforcer.recordCost(testScope, testUsage, testPricing, testExtra)

      const content = readFileSync(config.ledgerPath, "utf8")
      const entry = JSON.parse(content.trim())
      const keys = Object.keys(entry)
      assert.equal(keys.length, 16, `Expected 16 fields, got ${keys.length}: ${keys.join(", ")}`)
    } finally {
      cleanup(dir)
    }
  })

  // --- isExceeded / isWarning ---

  await test("isExceeded returns false when under budget", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig(dir)
      const enforcer = new BudgetEnforcer(config)
      await enforcer.recordCost(testScope, testUsage, testPricing, testExtra)

      assert.equal(enforcer.isExceeded(testScope), false)
    } finally {
      cleanup(dir)
    }
  })

  await test("isExceeded returns true when over budget", async () => {
    const dir = makeTempDir()
    try {
      const keys = deriveScopeKey(testScope)
      const config = makeConfig(dir, {
        budgets: { [keys.sprint]: 0.001 }, // Very small budget
      })
      const enforcer = new BudgetEnforcer(config)
      await enforcer.recordCost(testScope, testUsage, testPricing, testExtra)

      assert.equal(enforcer.isExceeded(testScope), true)
    } finally {
      cleanup(dir)
    }
  })

  await test("isWarning returns true at warn threshold", async () => {
    const dir = makeTempDir()
    try {
      const keys = deriveScopeKey(testScope)
      const singleCost = calculateCost(testUsage, testPricing)
      // Set budget so a single call puts us at ~75%
      const config = makeConfig(dir, {
        budgets: { [keys.sprint]: singleCost / 0.75 },
        warnPercent: 50,
      })
      const enforcer = new BudgetEnforcer(config)
      await enforcer.recordCost(testScope, testUsage, testPricing, testExtra)

      assert.equal(enforcer.isWarning(testScope), true)
      assert.equal(enforcer.isExceeded(testScope), false)
    } finally {
      cleanup(dir)
    }
  })

  await test("isExceeded returns false when no budget configured", () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig(dir, { budgets: {} })
      const enforcer = new BudgetEnforcer(config)
      assert.equal(enforcer.isExceeded(testScope), false)
    } finally {
      cleanup(dir)
    }
  })

  // --- Checkpoint recovery ---

  await test("initFromCheckpoint restores counters", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig(dir)
      const keys = deriveScopeKey(testScope)

      // First enforcer records some cost
      const enforcer1 = new BudgetEnforcer(config)
      await enforcer1.recordCost(testScope, testUsage, testPricing, testExtra)
      const snapshot1 = enforcer1.getBudgetSnapshot(testScope)

      // Second enforcer loads from checkpoint
      const enforcer2 = new BudgetEnforcer(config)
      await enforcer2.initFromCheckpoint()
      const snapshot2 = enforcer2.getBudgetSnapshot(testScope)

      assert.ok(Math.abs(snapshot1.spent_usd - snapshot2.spent_usd) < 1e-10)
    } finally {
      cleanup(dir)
    }
  })

  await test("initFromCheckpoint handles missing checkpoint", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig(dir)
      const enforcer = new BudgetEnforcer(config)
      await enforcer.initFromCheckpoint() // Should not throw
      assert.equal(enforcer.isExceeded(testScope), false)
    } finally {
      cleanup(dir)
    }
  })

  // --- fail-open / fail-closed ---

  await test("fail-open continues on ledger write failure", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig(dir, {
        ledgerPath: "/nonexistent/path/cost-ledger.jsonl",
        onLedgerFailure: "fail-open",
      })
      const enforcer = new BudgetEnforcer(config)

      // Suppress expected error output
      const origError = console.error
      const errors: string[] = []
      console.error = (...args: unknown[]) => errors.push(String(args[0]))

      await enforcer.recordCost(testScope, testUsage, testPricing, testExtra)
      // Should not throw
      assert.ok(errors.some(e => e.includes("fail-open")))
      assert.equal(enforcer.isStateUnknown(), true)

      console.error = origError
    } finally {
      cleanup(dir)
    }
  })

  await test("fail-closed throws on ledger write failure", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig(dir, {
        ledgerPath: "/nonexistent/path/cost-ledger.jsonl",
        onLedgerFailure: "fail-closed",
      })
      const enforcer = new BudgetEnforcer(config)

      await assert.rejects(
        () => enforcer.recordCost(testScope, testUsage, testPricing, testExtra),
        (err: any) => err.code === "METERING_UNAVAILABLE",
      )
    } finally {
      cleanup(dir)
    }
  })

  // --- getBudgetSnapshot ---

  await test("getBudgetSnapshot returns correct snapshot", async () => {
    const dir = makeTempDir()
    try {
      const keys = deriveScopeKey(testScope)
      const config = makeConfig(dir, {
        budgets: { [keys.sprint]: 1.0 },
        warnPercent: 80,
      })
      const enforcer = new BudgetEnforcer(config)
      await enforcer.recordCost(testScope, testUsage, testPricing, testExtra)

      const snapshot = enforcer.getBudgetSnapshot(testScope)
      assert.equal(snapshot.scope, keys.sprint)
      assert.equal(snapshot.limit_usd, 1.0)
      assert.ok(snapshot.spent_usd > 0)
      assert.ok(snapshot.percent_used > 0)
      assert.equal(snapshot.exceeded, false)
    } finally {
      cleanup(dir)
    }
  })

  console.log("\nDone.")
}

main()
