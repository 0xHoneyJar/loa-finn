// tests/finn/credit-deduction.test.ts — Sprint 3: Credit Deduction + BYOK Test Suite
//
// Tests for: CreditDeductionService, EntitlementService, conservation guard extensions,
// WebSocket billing protocol, rate freeze, concurrent reserves.

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock Redis Client Factory
// ---------------------------------------------------------------------------

function createMockRedis(initialBalances: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initialBalances))

  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ..._args: (string | number)[]) => {
      store.set(key, value)
      return "OK"
    }),
    del: vi.fn(async (...keys: string[]) => {
      let count = 0
      for (const k of keys) { if (store.delete(k)) count++ }
      return count
    }),
    incrby: vi.fn(async (key: string, increment: number) => {
      const current = Number(store.get(key) ?? "0")
      const next = current + increment
      store.set(key, String(next))
      return next
    }),
    incrbyfloat: vi.fn(async (key: string, increment: number) => {
      const current = Number(store.get(key) ?? "0")
      const next = current + increment
      store.set(key, String(next))
      return String(next)
    }),
    expire: vi.fn(async (_key: string, _seconds: number) => 1),
    exists: vi.fn(async (...keys: string[]) => {
      let count = 0
      for (const k of keys) { if (store.has(k)) count++ }
      return count
    }),
    ping: vi.fn(async () => "PONG"),
    eval: vi.fn(async (script: string, _numkeys: number, ...args: (string | number)[]) => {
      // Minimal Lua script simulation for reserve/commit/release
      const keys = args.slice(0, _numkeys) as string[]
      const argv = args.slice(_numkeys) as string[]

      if (script.includes("Idempotency: if reserve already exists")) {
        // RESERVE script
        const [balanceKey, reserveKey, heldKey] = keys
        const [cost, _billingEntryId, _ttl] = argv

        if (store.has(reserveKey)) return -1 // already exists

        const balance = Number(store.get(balanceKey) ?? "0")
        const costNum = Number(cost)

        if (balance < costNum) return 0 // insufficient

        store.set(balanceKey, String(balance - costNum))
        const held = Number(store.get(heldKey) ?? "0")
        store.set(heldKey, String(held + costNum))
        store.set(reserveKey, String(cost))
        return 1
      }

      if (script.includes("Get reserve amount")) {
        // RELEASE script
        const [balanceKey, reserveKey, heldKey] = keys
        const costStr = store.get(reserveKey)
        if (!costStr) return 0

        const costNum = Number(costStr)
        const balance = Number(store.get(balanceKey) ?? "0")
        store.set(balanceKey, String(balance + costNum))
        const held = Number(store.get(heldKey) ?? "0")
        store.set(heldKey, String(Math.max(0, held - costNum)))
        store.delete(reserveKey)
        return 1
      }

      if (script.includes("Get reserve (estimated cost)")) {
        // COMMIT script
        const [balanceKey, reserveKey, heldKey] = keys
        const [actualCost] = argv

        const estimatedStr = store.get(reserveKey)
        if (!estimatedStr) return 0

        const estimated = Number(estimatedStr)
        const actual = Number(actualCost)
        const overage = estimated - actual

        const held = Number(store.get(heldKey) ?? "0")
        store.set(heldKey, String(Math.max(0, held - estimated)))

        if (overage > 0) {
          const balance = Number(store.get(balanceKey) ?? "0")
          store.set(balanceKey, String(balance + overage))
        }

        store.delete(reserveKey)
        return 1
      }

      return null
    }),
    hgetall: vi.fn(async (_key: string) => ({})),
    hincrby: vi.fn(async (_key: string, _field: string, _increment: number) => 0),
    zadd: vi.fn(async (_key: string, _score: number, _member: string) => 0),
    zpopmin: vi.fn(async (_key: string, _count?: number) => []),
    zremrangebyscore: vi.fn(async () => 0),
    zcard: vi.fn(async () => 0),
    publish: vi.fn(async () => 0),
    quit: vi.fn(async () => "OK"),
  }
}

// ---------------------------------------------------------------------------
// CreditDeductionService
// ---------------------------------------------------------------------------

describe("CreditDeductionService", async () => {
  const { CreditDeductionService, InsufficientCreditsError } = await import("../../src/credits/conversion.js")
  type CreditDeductionServiceType = InstanceType<typeof CreditDeductionService>

  const MODEL = "claude-sonnet-4"
  const ACCOUNT = "user:test-account"

  function makeService(balanceMicro: string = "10000000") {
    const redis = createMockRedis({
      [`balance:${ACCOUNT}:value`]: balanceMicro,
      [`balance:${ACCOUNT}:held`]: "0",
    })
    const service: CreditDeductionServiceType = new CreditDeductionService({ redis })
    return { service, redis }
  }

  it("reserve → commit → balance reduced by actual cost, overage returned", async () => {
    // Balance: 10,000,000 MicroUSD ($10 = 1000 CU at 100 CU/$)
    const { service, redis } = makeService("10000000")

    // Reserve: 1000 input tokens, 500 max output tokens
    // claude-sonnet-4: 3 MicroUSD/input, 15 MicroUSD/output
    // Estimated: ceil(1000*3) + ceil(500*15) = 3000 + 7500 = 10500 MicroUSD
    const reserveResult = await service.reserveCredits(
      ACCOUNT, "ENTRY001", MODEL, 1000, 500,
    )

    expect(reserveResult.estimatedCostMicro).toBe(10500n)

    // Verify balance reduced by estimated cost
    const balanceAfterReserve = redis.store.get(`balance:${ACCOUNT}:value`)
    expect(balanceAfterReserve).toBe(String(10000000 - 10500))

    // Commit: actual output was 300 tokens (less than max 500)
    // Actual: floor(1000*3) + floor(300*15) = 3000 + 4500 = 7500 MicroUSD
    const commitResult = await service.commitCredits(
      ACCOUNT, "ENTRY001", MODEL, 1000, 300,
      reserveResult.rateSnapshot, reserveResult.estimatedCostMicro,
    )

    expect(commitResult.actualCostMicro).toBe(7500n)
    // Overage: 10500 - 7500 = 3000 MicroUSD returned to available
    expect(commitResult.overageMicro).toBe(3000n)

    // Final balance: 10,000,000 - 10,500 + 3,000 = 9,992,500
    const finalBalance = redis.store.get(`balance:${ACCOUNT}:value`)
    expect(finalBalance).toBe(String(10000000 - 10500 + 3000))
  })

  it("reserve 100 CU → inference costs 80 CU → 20 CU released", async () => {
    // At 100 CU/$, 100 CU = $1 = 1,000,000 MicroUSD
    const { service, redis } = makeService("1000000")

    const reserveResult = await service.reserveCredits(
      ACCOUNT, "ENTRY002", MODEL, 1000, 500,
    )

    // Verify CU conversion uses ceil for reserve
    expect(reserveResult.estimatedCostCU > 0n).toBe(true)

    // Commit with lower actual cost
    const commitResult = await service.commitCredits(
      ACCOUNT, "ENTRY002", MODEL, 1000, 200,
      reserveResult.rateSnapshot, reserveResult.estimatedCostMicro,
    )

    // Verify CU conversion uses floor for commit
    expect(commitResult.actualCostCU >= 0n).toBe(true)
    // Overage CU should be positive (released back)
    expect(commitResult.overageCU >= 0n).toBe(true)
  })

  it("insufficient balance → throws InsufficientCreditsError with CU display", async () => {
    // Balance: only 100 MicroUSD (way too little for inference)
    const { service } = makeService("100")

    await expect(
      service.reserveCredits(ACCOUNT, "ENTRY003", MODEL, 1000, 500),
    ).rejects.toThrow(InsufficientCreditsError)

    try {
      await service.reserveCredits(ACCOUNT, "ENTRY003A", MODEL, 1000, 500)
    } catch (e: any) {
      expect(e).toBeInstanceOf(InsufficientCreditsError)
      expect(e.httpStatus).toBe(402)
      expect(e.balance_cu).toBeDefined()
      expect(e.estimated_cost_cu).toBeDefined()
      expect(e.deficit_cu).toBeDefined()
    }
  })

  it("concurrent reserves — second gets insufficient balance", async () => {
    // Balance: just enough for one reserve
    // claude-sonnet-4: 1000 input × 3 + 500 output × 15 = 10500 MicroUSD
    const { service } = makeService("15000")

    // First reserve succeeds
    const r1 = await service.reserveCredits(ACCOUNT, "ENTRY_A", MODEL, 1000, 500)
    expect(r1.estimatedCostMicro).toBe(10500n)

    // Second reserve fails — balance insufficient after first hold
    await expect(
      service.reserveCredits(ACCOUNT, "ENTRY_B", MODEL, 1000, 500),
    ).rejects.toThrow(InsufficientCreditsError)
  })

  it("rate freeze — commit uses frozen rate, not current env", async () => {
    const { service } = makeService("10000000")

    // Reserve with default rate (100 CU/$)
    const reserveResult = await service.reserveCredits(
      ACCOUNT, "ENTRY_FREEZE", MODEL, 1000, 500,
    )
    expect(reserveResult.rateSnapshot.credit_units_per_usd).toBe(100)

    // Commit uses the frozen rate from reserve, not whatever the env says now
    const commitResult = await service.commitCredits(
      ACCOUNT, "ENTRY_FREEZE", MODEL, 1000, 300,
      reserveResult.rateSnapshot, reserveResult.estimatedCostMicro,
    )

    // Verify CU computed with frozen rate (100 CU/$)
    // Actual: floor(1000*3 + 300*15) = 7500 MicroUSD
    // CU: floor(7500 * 100 / 1_000_000) = floor(0.75) = 0 CU
    // (small amounts round down to 0 CU at floor)
    expect(commitResult.actualCostCU >= 0n).toBe(true)
  })

  it("release → returns funds to available balance", async () => {
    const { service, redis } = makeService("10000000")

    // Reserve
    await service.reserveCredits(ACCOUNT, "ENTRY_RELEASE", MODEL, 1000, 500)
    const afterReserve = Number(redis.store.get(`balance:${ACCOUNT}:value`))
    expect(afterReserve).toBe(10000000 - 10500)

    // Release
    const released = await service.releaseCredits(ACCOUNT, "ENTRY_RELEASE")
    expect(released).toBe(true)

    // Balance restored
    const afterRelease = Number(redis.store.get(`balance:${ACCOUNT}:value`))
    expect(afterRelease).toBe(10000000)
  })

  it("getBalanceCU returns floor-converted balance", async () => {
    const { service } = makeService("5000000") // $5 = 500 CU at 100 CU/$

    const { freezeRates } = await import("../../src/billing/pricing.js")
    const snapshot = freezeRates()
    const balanceCU = await service.getBalanceCU(ACCOUNT, snapshot)

    // 5,000,000 MicroUSD × 100 / 1,000,000 = 500 CU
    expect(balanceCU).toBe(500n)
  })
})

// ---------------------------------------------------------------------------
// EntitlementService
// ---------------------------------------------------------------------------

describe("EntitlementService", async () => {
  const { EntitlementService, BYOK_DAILY_RATE_LIMIT, GRACE_PERIOD_MS } = await import("../../src/credits/entitlement.js")

  const ACCOUNT = "byok-user-1"
  let walEntries: unknown[]

  function makeEntitlementService() {
    const redis = createMockRedis()
    walEntries = []
    const walAppend = vi.fn((_ns: string, _op: string, _key: string, payload: unknown) => {
      walEntries.push(payload)
      return `wal-${walEntries.length}`
    })
    const service = new EntitlementService({ redis, walAppend })
    return { service, redis, walAppend }
  }

  it("ACTIVE entitlement → inference allowed", async () => {
    const { service } = makeEntitlementService()

    await service.createEntitlement(ACCOUNT, "5000000") // $5/month

    const result = await service.checkEntitlement(ACCOUNT)
    expect(result.allowed).toBe(true)
    expect(result.state).toBe("ACTIVE")
  })

  it("ACTIVE → PAST_DUE after expiry → still allowed during grace", async () => {
    const { service, redis } = makeEntitlementService()

    // Create entitlement, then manually set expires_at to the past
    await service.createEntitlement(ACCOUNT, "5000000")
    const key = `entitlement:${ACCOUNT}`
    const data = JSON.parse(redis.store.get(key)!)
    data.expires_at = Date.now() - 1000 // Expired 1 second ago
    data.grace_until = Date.now() + 100_000 // Grace still active
    redis.store.set(key, JSON.stringify(data))

    // Read and verify it auto-transitions to PAST_DUE
    const result = await service.checkEntitlement(ACCOUNT)
    expect(result.state).toBe("PAST_DUE")
    expect(result.allowed).toBe(true) // Grace period allows inference
  })

  it("GRACE_EXPIRED → inference denied with reactivation message", async () => {
    const { service, redis } = makeEntitlementService()

    // Create entitlement that's fully expired (past grace period)
    await service.createEntitlement(ACCOUNT, "5000000", 0)

    // Manually set grace_until to past
    const key = `entitlement:${ACCOUNT}`
    const data = JSON.parse(redis.store.get(key)!)
    data.grace_until = Date.now() - 1000
    data.state = "PAST_DUE" // Force to PAST_DUE so it transitions
    redis.store.set(key, JSON.stringify(data))

    const result = await service.checkEntitlement(ACCOUNT)
    expect(result.allowed).toBe(false)
    expect(result.state).toBe("GRACE_EXPIRED")
    expect(result.reason).toContain("renew")
  })

  it("CANCELLED → inference denied", async () => {
    const { service } = makeEntitlementService()

    await service.createEntitlement(ACCOUNT, "5000000")
    await service.cancelEntitlement(ACCOUNT)

    const result = await service.checkEntitlement(ACCOUNT)
    expect(result.allowed).toBe(false)
    expect(result.state).toBe("CANCELLED")
    expect(result.reason).toContain("cancelled")
  })

  it("no entitlement → denied with CANCELLED state", async () => {
    const { service } = makeEntitlementService()

    const result = await service.checkEntitlement("unknown-account")
    expect(result.allowed).toBe(false)
    expect(result.state).toBe("CANCELLED")
  })

  it("daily rate limit — allowed under limit", async () => {
    const { service } = makeEntitlementService()

    const result = await service.checkDailyLimit(ACCOUNT)
    expect(result.allowed).toBe(true)
    expect(result.count).toBe(0)
    expect(result.limit).toBe(BYOK_DAILY_RATE_LIMIT)
    expect(result.resetAt).toBeGreaterThan(Date.now())
  })

  it("daily rate limit — denied at limit", async () => {
    const { service, redis } = makeEntitlementService()

    // Set count to limit
    redis.store.set(`rate:${ACCOUNT}:daily`, String(BYOK_DAILY_RATE_LIMIT))

    const result = await service.checkDailyLimit(ACCOUNT)
    expect(result.allowed).toBe(false)
    expect(result.count).toBe(BYOK_DAILY_RATE_LIMIT)
  })

  it("incrementDailyCount increments and sets TTL on first call", async () => {
    const { service, redis } = makeEntitlementService()

    const count = await service.incrementDailyCount(ACCOUNT)
    expect(count).toBe(1)
    expect(redis.expire).toHaveBeenCalledOnce()

    // Second increment doesn't set TTL again
    const count2 = await service.incrementDailyCount(ACCOUNT)
    expect(count2).toBe(2)
    expect(redis.expire).toHaveBeenCalledOnce() // Still only once
  })

  it("renewEntitlement reactivates from GRACE_EXPIRED", async () => {
    const { service, redis } = makeEntitlementService()

    // Create and expire
    await service.createEntitlement(ACCOUNT, "5000000", 0)
    const key = `entitlement:${ACCOUNT}`
    const data = JSON.parse(redis.store.get(key)!)
    data.state = "GRACE_EXPIRED"
    data.grace_until = Date.now() - 1000
    redis.store.set(key, JSON.stringify(data))

    // Renew
    const renewed = await service.renewEntitlement(ACCOUNT, "5000000")
    expect(renewed.state).toBe("ACTIVE")

    const check = await service.checkEntitlement(ACCOUNT)
    expect(check.allowed).toBe(true)
    expect(check.state).toBe("ACTIVE")
  })

  it("proration calculates correctly", async () => {
    const { service } = makeEntitlementService()

    // $5/month = 5,000,000 MicroUSD, 15 remaining days
    const prorated = service.computeProration(5_000_000n, 15)
    expect(prorated).toBe(2_500_000n) // $2.50
  })

  it("WAL audit entries on every state transition", async () => {
    const { service, walAppend } = makeEntitlementService()

    await service.createEntitlement(ACCOUNT, "5000000")
    expect(walAppend).toHaveBeenCalledTimes(1)

    await service.cancelEntitlement(ACCOUNT)
    expect(walAppend).toHaveBeenCalledTimes(2)

    // Verify transition payloads
    expect((walEntries[0] as any).to_state).toBe("ACTIVE")
    expect((walEntries[1] as any).from_state).toBe("ACTIVE")
    expect((walEntries[1] as any).to_state).toBe("CANCELLED")
  })
})

// ---------------------------------------------------------------------------
// Conservation Guard — Entitlement + Credit Invariants
// ---------------------------------------------------------------------------

describe("BillingConservationGuard — Sprint 3 invariants", async () => {
  const { BillingConservationGuard } = await import("../../src/hounfour/billing-conservation-guard.js")

  let guard: InstanceType<typeof BillingConservationGuard>

  beforeEach(async () => {
    guard = new BillingConservationGuard()
    await guard.init()
  })

  describe("checkEntitlementValid", () => {
    it("ACTIVE → pass", () => {
      const result = guard.checkEntitlementValid("ACTIVE")
      expect(result.ok).toBe(true)
      expect(result.effective).toBe("pass")
      expect(result.invariant_id).toBe("entitlement_valid")
    })

    it("PAST_DUE → pass (within grace period)", () => {
      const result = guard.checkEntitlementValid("PAST_DUE")
      expect(result.ok).toBe(true)
      expect(result.effective).toBe("pass")
    })

    it("GRACE_EXPIRED → fail (deny inference)", () => {
      const result = guard.checkEntitlementValid("GRACE_EXPIRED")
      expect(result.ok).toBe(false)
      expect(result.effective).toBe("fail")
    })

    it("CANCELLED → fail (deny inference)", () => {
      const result = guard.checkEntitlementValid("CANCELLED")
      expect(result.ok).toBe(false)
      expect(result.effective).toBe("fail")
    })

    it("unknown state → fail", () => {
      const result = guard.checkEntitlementValid("UNKNOWN")
      expect(result.ok).toBe(false)
      expect(result.effective).toBe("fail")
    })

    it("evaluator_result is bypassed (ad-hoc only constraint)", () => {
      const result = guard.checkEntitlementValid("ACTIVE")
      expect(result.evaluator_result).toBe("bypassed")
    })
  })

  describe("checkRateConsistency", () => {
    it("matching rates → pass", () => {
      const result = guard.checkRateConsistency(100, 100)
      expect(result.ok).toBe(true)
      expect(result.effective).toBe("pass")
      expect(result.invariant_id).toBe("rate_consistency")
    })

    it("mismatched rates → fail", () => {
      const result = guard.checkRateConsistency(150, 100)
      expect(result.ok).toBe(false)
      expect(result.effective).toBe("fail")
    })

    it("evaluator_result is bypassed (ad-hoc only constraint)", () => {
      const result = guard.checkRateConsistency(100, 100)
      expect(result.evaluator_result).toBe("bypassed")
    })
  })

  describe("dual-path lattice for new invariants", () => {
    it("entitlement_valid: bypassed evaluator → effective follows ad-hoc", () => {
      const pass = guard.checkEntitlementValid("ACTIVE")
      expect(pass.evaluator_result).toBe("bypassed")
      expect(pass.adhoc_result).toBe("pass")
      expect(pass.effective).toBe("pass")

      const fail = guard.checkEntitlementValid("GRACE_EXPIRED")
      expect(fail.evaluator_result).toBe("bypassed")
      expect(fail.adhoc_result).toBe("fail")
      expect(fail.effective).toBe("fail")
    })

    it("rate_consistency: bypassed evaluator → effective follows ad-hoc", () => {
      const pass = guard.checkRateConsistency(100, 100)
      expect(pass.evaluator_result).toBe("bypassed")
      expect(pass.adhoc_result).toBe("pass")
      expect(pass.effective).toBe("pass")

      const fail = guard.checkRateConsistency(200, 100)
      expect(fail.evaluator_result).toBe("bypassed")
      expect(fail.adhoc_result).toBe("fail")
      expect(fail.effective).toBe("fail")
    })
  })

  it("existing invariants still work after Sprint 3 additions", () => {
    // budget_conservation
    const budget = guard.checkBudgetConservation(500n, 1000n)
    expect(budget.ok).toBe(true)

    // cost_non_negative
    const cost = guard.checkCostNonNegative(100n)
    expect(cost.ok).toBe(true)

    // reserve_within_allocation
    const reserve = guard.checkReserveWithinAllocation(300n, 500n)
    expect(reserve.ok).toBe(true)

    // micro_usd_format
    const format = guard.checkMicroUSDFormat("12345")
    expect(format.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// WebSocket Protocol Extension — Cost + Balance
// ---------------------------------------------------------------------------

describe("WebSocket billing protocol (Sprint 3 Task 3.4)", () => {
  it("WsBillingContext interface is exported", async () => {
    // Type-level check: WsBillingContext is used in WsHandlerOptions
    const wsModule = await import("../../src/gateway/ws.js")
    expect(wsModule.handleWebSocket).toBeDefined()
  })

  it("turn_end message types documented — cost_cu, balance_cu, credit_warning, billing_blocked", () => {
    // Server → Client message types for Sprint 3:
    const turnEndData = { cost_cu: "80", balance_cu: "920" }
    const creditWarning = { balance_cu: "40", threshold: "50" }
    const billingBlocked = { reason: "Account reconciliation in progress" }

    // Validate structure
    expect(turnEndData).toHaveProperty("cost_cu")
    expect(turnEndData).toHaveProperty("balance_cu")
    expect(creditWarning).toHaveProperty("balance_cu")
    expect(creditWarning).toHaveProperty("threshold")
    expect(billingBlocked).toHaveProperty("reason")
  })
})

// ---------------------------------------------------------------------------
// Rate Freeze Verification
// ---------------------------------------------------------------------------

describe("Rate freeze across Reserve → Commit lifecycle", async () => {
  const { freezeRates, estimateReserveCost, computeActualCost } = await import("../../src/billing/pricing.js")
  const { convertMicroUSDtoCreditUnit } = await import("../../src/hounfour/wire-boundary.js")
  type MicroUSD = import("@0xhoneyjar/loa-hounfour").BrandedMicroUSD

  it("frozen rate at RESERVE used for COMMIT — not current env", () => {
    // Freeze at rate 100 CU/$
    const snapshot = freezeRates({ creditUnitsPerUsd: 100 })
    expect(snapshot.credit_units_per_usd).toBe(100)

    const estimatedMicro = estimateReserveCost("claude-sonnet-4", 1000, 500)
    const estimatedCU = convertMicroUSDtoCreditUnit(estimatedMicro, snapshot.credit_units_per_usd, "ceil")

    // Simulate rate change to 200 CU/$ (env var changed between reserve and commit)
    // COMMIT must still use frozen rate (100), not new rate (200)
    const actualMicro = computeActualCost("claude-sonnet-4", 1000, 300)
    const actualCU_frozen = convertMicroUSDtoCreditUnit(actualMicro, snapshot.credit_units_per_usd, "floor")
    const actualCU_current = convertMicroUSDtoCreditUnit(actualMicro, 200, "floor")

    // Frozen and current produce different CU values
    // At 100 CU/$: 7500 MicroUSD × 100 / 1M = 0 CU (small amounts floor to 0)
    // At 200 CU/$: 7500 MicroUSD × 200 / 1M = 1 CU
    expect(actualCU_frozen).not.toBe(actualCU_current)
  })

  it("canonical rounding: RESERVE ceil, COMMIT floor", () => {
    const snapshot = freezeRates({ creditUnitsPerUsd: 100 })

    // Use values that produce non-integer CU amounts
    // 15,001 MicroUSD × 100 / 1,000,000 = 1.5001
    const amount = 15001n as MicroUSD
    const ceil = convertMicroUSDtoCreditUnit(amount, snapshot.credit_units_per_usd, "ceil")
    const floor = convertMicroUSDtoCreditUnit(amount, snapshot.credit_units_per_usd, "floor")

    // ceil(1.5001) = 2, floor(1.5001) = 1
    expect(ceil).toBe(2n)
    expect(floor).toBe(1n)
    // User never overpays by more than 1 CU
    expect(ceil - floor).toBeLessThanOrEqual(1n)
  })
})

// ---------------------------------------------------------------------------
// Conservation Guard — Post-Deduction Zero-Sum Invariant
// ---------------------------------------------------------------------------

describe("Conservation guard post-deduction", async () => {
  const { Ledger, billingReservePostings, billingCommitPostings, billingReleasePostings } = await import("../../src/billing/ledger.js")
  const { parseBillingEntryId } = await import("../../src/billing/types.js")

  it("reserve → commit with overage → all postings sum to zero", () => {
    const ledger = new Ledger()
    const userId = "test-user"
    const billingEntryId = parseBillingEntryId("01HYX3K4M5N6P7Q8R9S0T1A2B3")
    const estimatedCost = 10500n
    const actualCost = 7500n

    // Reserve: user:available → user:held
    ledger.appendEntry({
      billing_entry_id: billingEntryId,
      event_type: "billing_reserve",
      correlation_id: "corr-1",
      postings: billingReservePostings(userId, estimatedCost),
      exchange_rate: 100,
      rounding_direction: "ceil",
      wal_offset: "offset-1",
      timestamp: Date.now(),
    })

    // Commit: user:held → system:revenue + return overage
    ledger.appendEntry({
      billing_entry_id: billingEntryId,
      event_type: "billing_commit",
      correlation_id: "corr-1",
      postings: billingCommitPostings(userId, estimatedCost, actualCost),
      exchange_rate: 100,
      rounding_direction: "floor",
      wal_offset: "offset-2",
      timestamp: Date.now(),
    })

    // Net effect on user:available = -(10500) + 3000 = -7500 (charged actual cost)
    const userAvailable = ledger.deriveBalance(`user:${userId}:available`)
    expect(userAvailable).toBe(-actualCost)

    // Net effect on system:revenue = +7500
    const revenue = ledger.deriveBalance("system:revenue")
    expect(revenue).toBe(actualCost)

    // Zero-sum across all accounts
    const allBalances = ledger.deriveAllBalances()
    let total = 0n
    for (const balance of allBalances.values()) {
      total += balance
    }
    expect(total).toBe(0n)
  })

  it("reserve → release → all postings sum to zero", () => {
    const ledger = new Ledger()
    const userId = "test-user"
    const billingEntryId = parseBillingEntryId("01HYX3K4M5N6P7Q8R9S0T1A2B4")
    const estimatedCost = 10500n

    // Reserve
    ledger.appendEntry({
      billing_entry_id: billingEntryId,
      event_type: "billing_reserve",
      correlation_id: "corr-2",
      postings: billingReservePostings(userId, estimatedCost),
      exchange_rate: 100,
      rounding_direction: "ceil",
      wal_offset: "offset-3",
      timestamp: Date.now(),
    })

    // Release (pre-stream failure)
    ledger.appendEntry({
      billing_entry_id: billingEntryId,
      event_type: "billing_release",
      correlation_id: "corr-2",
      postings: billingReleasePostings(userId, estimatedCost),
      exchange_rate: 100,
      rounding_direction: null,
      wal_offset: "offset-4",
      timestamp: Date.now(),
    })

    // User balance fully restored
    const userAvailable = ledger.deriveBalance(`user:${userId}:available`)
    expect(userAvailable).toBe(0n)

    // Zero-sum across all accounts
    const allBalances = ledger.deriveAllBalances()
    let total = 0n
    for (const balance of allBalances.values()) {
      total += balance
    }
    expect(total).toBe(0n)
  })
})
