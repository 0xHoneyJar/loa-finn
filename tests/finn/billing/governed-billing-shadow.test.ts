// tests/finn/billing/governed-billing-shadow.test.ts — T-5.3
// Integration tests for GovernedBilling shadow-mode wiring.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { BillingState } from "../../../src/billing/types.js"
import type {
  BillingEntry,
  BillingEntryId,
  BillingWALEnvelope,
  ExchangeRateSnapshot,
} from "../../../src/billing/types.js"
import type { BillingStateMachineDeps } from "../../../src/billing/state-machine.js"
import { parseMicroUSD } from "../../../src/hounfour/wire-boundary.js"
import type { BrandedMicroUSD as MicroUSD } from "@0xhoneyjar/loa-hounfour"
import { GovernedBilling } from "../../../src/billing/governed-billing.js"

// ---------------------------------------------------------------------------
// Helpers (same pattern as billing-state-machine.test.ts)
// ---------------------------------------------------------------------------

function makeId(suffix: string = "TEST"): BillingEntryId {
  return `01ARYZ6S41${suffix.padEnd(16, "0")}` as BillingEntryId
}

function makeDeps(overrides?: Partial<BillingStateMachineDeps>): BillingStateMachineDeps & {
  walEntries: BillingWALEnvelope[]
  redisState: Map<string, BillingEntry>
  finalizeCalls: Array<{ billingEntryId: string; accountId: string; actualCost: MicroUSD }>
} {
  const walEntries: BillingWALEnvelope[] = []
  const redisState = new Map<string, BillingEntry>()
  const finalizeCalls: Array<{ billingEntryId: string; accountId: string; actualCost: MicroUSD }> = []
  let idCounter = 0

  return {
    walEntries,
    redisState,
    finalizeCalls,
    walAppend: (envelope: BillingWALEnvelope) => {
      walEntries.push(envelope)
      return `offset-${walEntries.length}`
    },
    redisUpdate: async (entry: BillingEntry) => {
      redisState.set(entry.billing_entry_id, { ...entry })
    },
    enqueueFinalze: async (billingEntryId, accountId, actualCost) => {
      finalizeCalls.push({ billingEntryId, accountId, actualCost })
    },
    generateId: () => makeId(`ID${String(++idCounter).padStart(14, "0")}`),
    ...overrides,
  }
}

function defaultRateSnapshot(): ExchangeRateSnapshot {
  return {
    credit_units_per_usd: 100,
    usd_usdc_rate: 1.0,
    frozen_at: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Dynamic import helper — env var must be set BEFORE import
// ---------------------------------------------------------------------------

async function importStateMachine() {
  // Force fresh module import so GOVERNED_BILLING_ENABLED reads current env
  const mod = await import("../../../src/billing/state-machine.js")
  return mod
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GovernedBilling shadow mode — flag OFF (default)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    delete process.env.FINN_GOVERNED_BILLING
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.FINN_GOVERNED_BILLING
  })

  it("flag absent: no shadow instantiation, no console.log calls", async () => {
    // FINN_GOVERNED_BILLING is absent (deleted above)
    const { BillingStateMachine } = await importStateMachine()
    const deps = makeDeps()
    const sm = new BillingStateMachine(deps)

    await sm.reserve("user-1", parseMicroUSD("1000"), "corr-1", defaultRateSnapshot())

    // No governed_billing_* logs emitted
    const governedLogs = logSpy.mock.calls.filter((args) => {
      const str = typeof args[0] === "string" ? args[0] : ""
      return str.includes("governed_billing")
    })
    expect(governedLogs).toHaveLength(0)
  })

  it("flag=false: no shadow instantiation", async () => {
    process.env.FINN_GOVERNED_BILLING = "false"
    const { BillingStateMachine } = await importStateMachine()
    const deps = makeDeps()
    const sm = new BillingStateMachine(deps)

    await sm.reserve("user-1", parseMicroUSD("1000"), "corr-1", defaultRateSnapshot())

    const governedLogs = logSpy.mock.calls.filter((args) => {
      const str = typeof args[0] === "string" ? args[0] : ""
      return str.includes("governed_billing")
    })
    expect(governedLogs).toHaveLength(0)
  })
})

describe("GovernedBilling shadow mode — flag ON", () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env.FINN_GOVERNED_BILLING = "true"
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.FINN_GOVERNED_BILLING
  })

  it("shadow produces identical state for reserve transition", async () => {
    const { BillingStateMachine } = await importStateMachine()
    const deps = makeDeps()
    const sm = new BillingStateMachine(deps)

    await sm.reserve("user-1", parseMicroUSD("1000"), "corr-1", defaultRateSnapshot())

    // Should have invariant telemetry but NO divergence
    const logs = logSpy.mock.calls
      .map((args) => args[0])
      .filter((s): s is string => typeof s === "string" && s.includes("governed_billing"))

    // Expect invariant telemetry log
    const invariantLogs = logs.filter((s) => s.includes("governed_billing_invariants"))
    expect(invariantLogs.length).toBeGreaterThanOrEqual(1)

    const parsed = JSON.parse(invariantLogs[0])
    expect(parsed.event).toBe("governed_billing_invariants")
    expect(parsed.all_hold).toBe(true)
    expect(parsed.invariants.cost_non_negative).toBe(true)
    expect(parsed.invariants.valid_state).toBe(true)
    expect(parsed.invariants.reserve_conservation).toBe(true)

    // No divergence
    const divergenceLogs = logs.filter((s) => s.includes("governed_billing_divergence"))
    expect(divergenceLogs).toHaveLength(0)
  })

  it("shadow produces identical state for full lifecycle", async () => {
    const { BillingStateMachine } = await importStateMachine()
    const deps = makeDeps()
    const sm = new BillingStateMachine(deps)

    const entry = await sm.reserve("user-1", parseMicroUSD("1000"), "corr-1", defaultRateSnapshot())
    const committed = await sm.commit(entry, parseMicroUSD("800"))
    await sm.finalizeAck(committed, 200)

    // 3 transitions = 3 invariant logs, 0 divergence logs
    const logs = logSpy.mock.calls
      .map((args) => args[0])
      .filter((s): s is string => typeof s === "string" && s.includes("governed_billing"))

    const invariantLogs = logs.filter((s) => s.includes("governed_billing_invariants"))
    expect(invariantLogs.length).toBe(3)

    const divergenceLogs = logs.filter((s) => s.includes("governed_billing_divergence"))
    expect(divergenceLogs).toHaveLength(0)

    // All invariants hold across all transitions
    for (const log of invariantLogs) {
      const parsed = JSON.parse(log)
      expect(parsed.all_hold).toBe(true)
    }
  })

  it("invariant telemetry has correct structured format", async () => {
    const { BillingStateMachine } = await importStateMachine()
    const deps = makeDeps()
    const sm = new BillingStateMachine(deps)

    await sm.reserve("user-1", parseMicroUSD("500"), "corr-fmt", defaultRateSnapshot())

    const invariantLog = logSpy.mock.calls
      .map((args) => args[0])
      .find((s): s is string => typeof s === "string" && s.includes("governed_billing_invariants"))

    expect(invariantLog).toBeDefined()
    const parsed = JSON.parse(invariantLog!)

    // Required fields per T-5.2 AC
    expect(parsed).toHaveProperty("event", "governed_billing_invariants")
    expect(parsed).toHaveProperty("entryId")
    expect(parsed).toHaveProperty("invariants")
    expect(parsed).toHaveProperty("all_hold")
    expect(parsed.invariants).toHaveProperty("cost_non_negative")
    expect(parsed.invariants).toHaveProperty("valid_state")
    expect(parsed.invariants).toHaveProperty("reserve_conservation")
  })

  it("divergence detection via mock — shadow returns different state", async () => {
    const { BillingStateMachine } = await importStateMachine()
    const deps = makeDeps()
    const sm = new BillingStateMachine(deps)

    // Spy on GovernedBilling.prototype.runShadow to force a divergence
    const originalRunShadow = GovernedBilling.prototype.runShadow
    vi.spyOn(GovernedBilling.prototype, "runShadow").mockImplementation(function (this: GovernedBilling, eventType) {
      const realResult = originalRunShadow.call(this, eventType)
      // Force shadow to report a different state
      return {
        ...realResult,
        shadowState: BillingState.VOIDED,
      }
    })

    const entry = await sm.reserve("user-1", parseMicroUSD("1000"), "corr-div", defaultRateSnapshot())
    await sm.commit(entry, parseMicroUSD("800"))

    const divergenceLogs = logSpy.mock.calls
      .map((args) => args[0])
      .filter((s): s is string => typeof s === "string" && s.includes("governed_billing_divergence"))

    // Both reserve and commit should report divergence
    expect(divergenceLogs.length).toBe(2)

    const parsed = JSON.parse(divergenceLogs[0])
    expect(parsed.event).toBe("governed_billing_divergence")
    expect(parsed).toHaveProperty("entryId")
    expect(parsed).toHaveProperty("primary_state")
    expect(parsed.shadow_state).toBe(BillingState.VOIDED)
    expect(parsed).toHaveProperty("event_type")
  })

  it("shadow purity: no I/O operations during shadow comparison", async () => {
    const { BillingStateMachine } = await importStateMachine()
    const deps = makeDeps()
    const sm = new BillingStateMachine(deps)

    // Track call counts before shadow runs
    const walCallsBefore = deps.walEntries.length
    const redisCallCount = vi.fn()
    const originalRedisUpdate = deps.redisUpdate
    deps.redisUpdate = async (entry: BillingEntry) => {
      redisCallCount()
      return originalRedisUpdate(entry)
    }

    await sm.reserve("user-1", parseMicroUSD("1000"), "corr-pure", defaultRateSnapshot())

    // WAL should have exactly 1 entry (from primary, not shadow)
    expect(deps.walEntries.length).toBe(walCallsBefore + 1)
    // Redis should be called exactly once (from primary, not shadow)
    expect(redisCallCount).toHaveBeenCalledTimes(1)
    // Finalize should not be called for reserve
    expect(deps.finalizeCalls).toHaveLength(0)
  })

  it("shadow overhead is within performance budget (<5ms per transition)", async () => {
    const { BillingStateMachine } = await importStateMachine()
    const deps = makeDeps()
    const sm = new BillingStateMachine(deps)

    // Warm up
    await sm.reserve("user-warm", parseMicroUSD("100"), "corr-warm", defaultRateSnapshot())

    // Measure shadow overhead across 100 iterations
    const iterations = 100
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      const entry: BillingEntry = {
        billing_entry_id: makeId(`PERF${String(i).padStart(12, "0")}`),
        correlation_id: `corr-perf-${i}`,
        state: BillingState.RESERVE_HELD,
        account_id: "user-perf",
        estimated_cost: parseMicroUSD("1000"),
        actual_cost: null,
        exchange_rate_snapshot: defaultRateSnapshot(),
        created_at: Date.now(),
        updated_at: Date.now(),
        wal_offset: "offset-perf",
        finalize_attempts: 0,
      }
      const shadow = new GovernedBilling(entry.billing_entry_id, entry)
      shadow.runShadow("billing_commit")
    }
    const elapsed = performance.now() - start
    const perIteration = elapsed / iterations

    // Must be <5ms per transition per T-5.1 AC
    expect(perIteration).toBeLessThan(5)
  })
})

describe("GovernedBilling.runShadow — unit tests", () => {
  it("produces correct state for each event type", () => {
    const baseEntry: BillingEntry = {
      billing_entry_id: makeId(),
      correlation_id: "corr-unit",
      state: BillingState.RESERVE_HELD,
      account_id: "user-1",
      estimated_cost: parseMicroUSD("1000"),
      actual_cost: null,
      exchange_rate_snapshot: defaultRateSnapshot(),
      created_at: Date.now(),
      updated_at: Date.now(),
      wal_offset: "offset-1",
      finalize_attempts: 0,
    }

    // RESERVE_HELD → commit → FINALIZE_PENDING
    const commitShadow = new GovernedBilling(baseEntry.billing_entry_id, baseEntry)
    const commitResult = commitShadow.runShadow("billing_commit")
    expect(commitResult.shadowState).toBe(BillingState.FINALIZE_PENDING)

    // RESERVE_HELD → release → RELEASED
    const releaseShadow = new GovernedBilling(baseEntry.billing_entry_id, baseEntry)
    const releaseResult = releaseShadow.runShadow("billing_release")
    expect(releaseResult.shadowState).toBe(BillingState.RELEASED)
  })

  it("invariants hold for valid entry", () => {
    const entry: BillingEntry = {
      billing_entry_id: makeId(),
      correlation_id: "corr-inv",
      state: BillingState.RESERVE_HELD,
      account_id: "user-1",
      estimated_cost: parseMicroUSD("1000"),
      actual_cost: null,
      exchange_rate_snapshot: defaultRateSnapshot(),
      created_at: Date.now(),
      updated_at: Date.now(),
      wal_offset: "offset-1",
      finalize_attempts: 0,
    }

    const shadow = new GovernedBilling(entry.billing_entry_id, entry)
    const result = shadow.runShadow("billing_commit")

    expect(result.allHold).toBe(true)
    expect(result.invariants.cost_non_negative).toBe(true)
    expect(result.invariants.valid_state).toBe(true)
    expect(result.invariants.reserve_conservation).toBe(true)
  })

  it("invalid transition returns unchanged state", () => {
    // RELEASED is terminal — no valid transitions
    const entry: BillingEntry = {
      billing_entry_id: makeId(),
      correlation_id: "corr-term",
      state: BillingState.RELEASED,
      account_id: "user-1",
      estimated_cost: parseMicroUSD("1000"),
      actual_cost: null,
      exchange_rate_snapshot: defaultRateSnapshot(),
      created_at: Date.now(),
      updated_at: Date.now(),
      wal_offset: "offset-1",
      finalize_attempts: 0,
    }

    const shadow = new GovernedBilling(entry.billing_entry_id, entry)
    const result = shadow.runShadow("billing_commit")

    // State unchanged — applyEvent returns original state for invalid transition
    expect(result.shadowState).toBe(BillingState.RELEASED)
  })
})
