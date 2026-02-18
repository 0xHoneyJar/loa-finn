// tests/finn/credit-purchase.test.ts — Credit Purchase + Pricing Test Suite (Sprint 2 Tasks 2.2, 2.4, 2.5, 2.7)

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Task 2.1: CreditUnit + MicroUSDC Branded Types
// ---------------------------------------------------------------------------

describe("CreditUnit branded type", async () => {
  const {
    parseCreditUnit,
    serializeCreditUnit,
    addCreditUnit,
    subtractCreditUnit,
    MAX_CREDIT_UNIT_LENGTH,
    WireBoundaryError,
  } = await import("../../src/hounfour/wire-boundary.js")

  it("parses valid positive CreditUnit", () => {
    const cu = parseCreditUnit("1000")
    expect(cu).toBe(1000n)
    expect(serializeCreditUnit(cu)).toBe("1000")
  })

  it("parses zero", () => {
    expect(parseCreditUnit("0")).toBe(0n)
  })

  it("parses negative (deficit tracking)", () => {
    expect(parseCreditUnit("-500")).toBe(-500n)
  })

  it("normalizes leading zeros", () => {
    expect(parseCreditUnit("007")).toBe(7n)
    expect(parseCreditUnit("000")).toBe(0n)
  })

  it("normalizes -0 to 0", () => {
    expect(parseCreditUnit("-0")).toBe(0n)
  })

  it("rejects empty string", () => {
    expect(() => parseCreditUnit("")).toThrow(WireBoundaryError)
  })

  it("rejects plus prefix", () => {
    expect(() => parseCreditUnit("+100")).toThrow(WireBoundaryError)
  })

  it("rejects non-digit characters", () => {
    expect(() => parseCreditUnit("12.5")).toThrow(WireBoundaryError)
    expect(() => parseCreditUnit("abc")).toThrow(WireBoundaryError)
  })

  it("rejects values exceeding max length", () => {
    const longValue = "1" + "0".repeat(MAX_CREDIT_UNIT_LENGTH)
    expect(() => parseCreditUnit(longValue)).toThrow(WireBoundaryError)
  })

  it("round-trip: parse(serialize(x)) === x", () => {
    const values = ["0", "1", "100", "999999", "-42"]
    for (const v of values) {
      const parsed = parseCreditUnit(v)
      expect(parseCreditUnit(serializeCreditUnit(parsed))).toBe(parsed)
    }
  })

  it("arithmetic preserves branding", () => {
    const a = parseCreditUnit("100")
    const b = parseCreditUnit("50")
    expect(addCreditUnit(a, b)).toBe(150n)
    expect(subtractCreditUnit(a, b)).toBe(50n)
  })
})

describe("MicroUSDC branded type", async () => {
  const {
    parseMicroUSDC,
    serializeMicroUSDC,
    WireBoundaryError,
  } = await import("../../src/hounfour/wire-boundary.js")

  it("parses valid MicroUSDC", () => {
    const usdc = parseMicroUSDC("10000000")
    expect(usdc).toBe(10_000_000n)
    expect(serializeMicroUSDC(usdc)).toBe("10000000")
  })

  it("rejects empty string", () => {
    expect(() => parseMicroUSDC("")).toThrow(WireBoundaryError)
  })

  it("rejects plus prefix", () => {
    expect(() => parseMicroUSDC("+5")).toThrow(WireBoundaryError)
  })

  it("round-trip: parse(serialize(x)) === x", () => {
    const values = ["0", "1", "5000000", "25000000"]
    for (const v of values) {
      const parsed = parseMicroUSDC(v)
      expect(parseMicroUSDC(serializeMicroUSDC(parsed))).toBe(parsed)
    }
  })
})

// ---------------------------------------------------------------------------
// Task 2.1: Denomination Conversion
// ---------------------------------------------------------------------------

describe("Denomination conversion", async () => {
  const {
    convertMicroUSDtoCreditUnit,
    convertCreditUnitToMicroUSD,
    convertMicroUSDtoMicroUSDC,
    parseMicroUSD,
  } = await import("../../src/hounfour/wire-boundary.js")

  const RATE = 100 // 100 CU per USD

  it("MicroUSD → CreditUnit floor (COMMIT rounding)", () => {
    // 50_000 MicroUSD = $0.05 = 5 CU at floor
    const result = convertMicroUSDtoCreditUnit(parseMicroUSD("50000"), RATE, "floor")
    expect(result).toBe(5n)
  })

  it("MicroUSD → CreditUnit ceil (RESERVE rounding)", () => {
    // 50_001 MicroUSD: ceil(50001 * 100 / 1_000_000) = ceil(5.0001) = 6
    const result = convertMicroUSDtoCreditUnit(parseMicroUSD("50001"), RATE, "ceil")
    expect(result).toBe(6n)
  })

  it("MicroUSD → CreditUnit ceil exact boundary", () => {
    // 50_000 MicroUSD: ceil(50000 * 100 / 1_000_000) = ceil(5.0) = 5
    const result = convertMicroUSDtoCreditUnit(parseMicroUSD("50000"), RATE, "ceil")
    expect(result).toBe(5n)
  })

  it("MicroUSD → CreditUnit zero", () => {
    expect(convertMicroUSDtoCreditUnit(parseMicroUSD("0"), RATE, "floor")).toBe(0n)
    expect(convertMicroUSDtoCreditUnit(parseMicroUSD("0"), RATE, "ceil")).toBe(0n)
  })

  it("CreditUnit → MicroUSD round-trip", () => {
    // 5 CU at 100 CU/USD = $0.05 = 50_000 MicroUSD
    const cu = convertMicroUSDtoCreditUnit(parseMicroUSD("50000"), RATE, "floor")
    const backToMicroUsd = convertCreditUnitToMicroUSD(cu, RATE)
    expect(backToMicroUsd).toBe(50_000n)
  })

  it("MicroUSD → MicroUSDC at 1:1 peg", () => {
    // 1_000_000 MicroUSD = $1.00 = 1_000_000 MicroUSDC at 1:1
    const result = convertMicroUSDtoMicroUSDC(parseMicroUSD("1000000"), 1.0, "ceil")
    expect(result).toBe(1_000_000n)
  })

  it("MicroUSD → MicroUSDC with markup", () => {
    // Non-1:1 rate: should still produce valid MicroUSDC
    const result = convertMicroUSDtoMicroUSDC(parseMicroUSD("1000000"), 1.001, "ceil")
    expect(result >= 1_000_000n).toBe(true) // At least 1:1
  })
})

// ---------------------------------------------------------------------------
// Task 2.2: Pricing Table + Cost Estimation
// ---------------------------------------------------------------------------

describe("Pricing", async () => {
  const {
    getModelPricing,
    estimateReserveCost,
    computeActualCost,
    estimateReserveCostCU,
    computeActualCostCU,
    computeX402Quote,
    freezeRates,
    resetModelPricingCache,
    PricingError,
    DEFAULT_CREDIT_UNITS_PER_USD,
  } = await import("../../src/billing/pricing.js")

  beforeEach(() => {
    resetModelPricingCache()
    delete process.env.FINN_MODEL_PRICING_JSON
  })

  it("returns pricing for known models", () => {
    const pricing = getModelPricing("claude-sonnet-4")
    expect(pricing.input_micro_usd_per_token).toBe(3)
    expect(pricing.output_micro_usd_per_token).toBe(15)
  })

  it("throws PricingError for unknown model", () => {
    expect(() => getModelPricing("unknown-model")).toThrow(PricingError)
  })

  it("estimateReserveCost uses ceil rounding", () => {
    // claude-sonnet-4: input=3, output=15
    // 1000 input tokens + 500 max output tokens
    // = ceil(1000*3) + ceil(500*15) = 3000 + 7500 = 10500
    const cost = estimateReserveCost("claude-sonnet-4", 1000, 500)
    expect(cost).toBe(10_500n)
  })

  it("computeActualCost uses floor rounding", () => {
    // gpt-4.1-mini: input=0.4, output=1.6
    // 1000 input + 300 output = floor(1000*0.4) + floor(300*1.6)
    // = floor(400) + floor(480) = 400 + 480 = 880
    const cost = computeActualCost("gpt-4.1-mini", 1000, 300)
    expect(cost).toBe(880n)
  })

  it("estimateReserveCost ceil rounds up for fractional rates", () => {
    // gpt-4.1-mini: input=0.4/token
    // 3 tokens: ceil(3 * 0.4) = ceil(1.2) = 2
    // + 0 output = 2
    const cost = estimateReserveCost("gpt-4.1-mini", 3, 0)
    expect(cost).toBe(2n)
  })

  it("computeActualCost floor rounds down for fractional rates", () => {
    // gpt-4.1-mini: input=0.4/token
    // 3 tokens: floor(3 * 0.4) = floor(1.2) = 1
    // + 0 output = 1
    const cost = computeActualCost("gpt-4.1-mini", 3, 0)
    expect(cost).toBe(1n)
  })

  it("estimateReserveCostCU converts with frozen rate", () => {
    const snapshot = freezeRates()
    const cu = estimateReserveCostCU("claude-sonnet-4", 1000, 500, snapshot)
    // 10500 MicroUSD at 100 CU/USD = ceil(10500 * 100 / 1_000_000) = ceil(1.05) = 2
    expect(cu).toBe(2n)
  })

  it("computeActualCostCU converts with frozen rate", () => {
    const snapshot = freezeRates()
    const cu = computeActualCostCU("claude-sonnet-4", 1000, 500, snapshot)
    // 10500 MicroUSD at 100 CU/USD = floor(10500 * 100 / 1_000_000) = floor(1.05) = 1
    expect(cu).toBe(1n)
  })

  it("computeX402Quote returns MicroUSDC with markup", () => {
    const quote = computeX402Quote("claude-sonnet-4", 1000, 500, 1.2)
    // Base: 10500 MicroUSD, markup 1.2 = ceil(12600) = 12600 MicroUSD
    // At 1:1 peg: 12600 MicroUSDC -> but conversion goes through convertMicroUSDtoMicroUSDC
    expect(quote > 0n).toBe(true)
  })

  it("freezeRates captures defaults", () => {
    const snapshot = freezeRates()
    expect(snapshot.credit_units_per_usd).toBe(DEFAULT_CREDIT_UNITS_PER_USD)
    expect(snapshot.usd_usdc_rate).toBe(1.0)
    expect(snapshot.frozen_at).toBeGreaterThan(0)
  })

  it("freezeRates accepts overrides", () => {
    const snapshot = freezeRates({ creditUnitsPerUsd: 200, usdUsdcRate: 0.99 })
    expect(snapshot.credit_units_per_usd).toBe(200)
    expect(snapshot.usd_usdc_rate).toBe(0.99)
  })

  it("env var overrides model pricing", () => {
    process.env.FINN_MODEL_PRICING_JSON = JSON.stringify({
      "test-model": { input_micro_usd_per_token: 10, output_micro_usd_per_token: 50 },
    })
    resetModelPricingCache()
    const pricing = getModelPricing("test-model")
    expect(pricing.input_micro_usd_per_token).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// Task 2.4: Credit Purchase Service
// ---------------------------------------------------------------------------

describe("CreditPurchaseService", async () => {
  const { CreditPurchaseService } = await import("../../src/credits/purchase.js")
  const { CreditPurchaseError, CREDIT_PACKS, isValidPackSize } = await import("../../src/credits/types.js")
  const { parseBillingEntryId } = await import("../../src/billing/types.js")
  const { Ledger } = await import("../../src/billing/ledger.js")

  function makeDeps(overrides?: Partial<any>) {
    const walEntries: unknown[] = []
    const redisStore = new Map<string, string>()

    return {
      primaryClient: {
        getTransactionReceipt: vi.fn().mockResolvedValue({
          status: "success",
          blockNumber: 100n,
          blockHash: "0xblockhash123",
          logs: [
            {
              address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              topics: [
                "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                "0x" + "0".repeat(24) + "sender".padStart(40, "0"),
                "0x" + "0".repeat(24) + "treasury".padStart(40, "0"),
              ],
              data: "0x" + (10_000_000n).toString(16).padStart(64, "0"),
              logIndex: 5,
            },
          ],
        }),
        getBlockNumber: vi.fn().mockResolvedValue(200n),
      } as any,
      fallbackClient: undefined,
      walAppend: vi.fn(async (_type: string, payload: unknown) => {
        walEntries.push(payload)
        return "01HWXYZ00000000000000WALOF"
      }),
      ledger: new Ledger(),
      redisGet: vi.fn(async (key: string) => redisStore.get(key) ?? null),
      redisSet: vi.fn(async (key: string, value: string, _ttl: number) => {
        redisStore.set(key, value)
      }),
      redisIncrBy: vi.fn(async (key: string, amount: bigint) => {
        const current = BigInt(redisStore.get(key) ?? "0")
        redisStore.set(key, (current + amount).toString())
      }),
      generateId: vi.fn(() => "01HWXYZ00000000000000ENTRY" as any),
      _walEntries: walEntries,
      _redisStore: redisStore,
      ...overrides,
    }
  }

  it("validates pack sizes", () => {
    expect(isValidPackSize(500)).toBe(true)
    expect(isValidPackSize(1000)).toBe(true)
    expect(isValidPackSize(2500)).toBe(true)
    expect(isValidPackSize(999)).toBe(false)
  })

  it("CREDIT_PACKS have correct values", () => {
    expect(CREDIT_PACKS[500].credit_units).toBe(500)
    expect(CREDIT_PACKS[500].usdc_amount).toBe(5_000_000n)
    expect(CREDIT_PACKS[1000].usdc_amount).toBe(10_000_000n)
    expect(CREDIT_PACKS[2500].usdc_amount).toBe(25_000_000n)
  })

  // Valid Ethereum test addresses (20 bytes hex, checksummed)
  const WALLET_A = "0x1111111111111111111111111111111111111111"
  const WALLET_B = "0x2222222222222222222222222222222222222222"
  const TREASURY = "0x3333333333333333333333333333333333333333"

  it("rejects invalid pack size", async () => {
    const deps = makeDeps()
    const service = new CreditPurchaseService(deps)

    await expect(
      service.purchase(
        { pack_size: 999, payment_proof: {} as any, idempotency_key: "test" },
        WALLET_A,
      ),
    ).rejects.toThrow(CreditPurchaseError)
  })

  it("rejects wrong chain ID", async () => {
    const deps = makeDeps()
    const service = new CreditPurchaseService(deps)

    await expect(
      service.purchase(
        {
          pack_size: 1000,
          payment_proof: {
            tx_hash: "0xabc",
            chain_id: 1, // wrong
            token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            sender: WALLET_A,
            amount_micro_usdc: "10000000",
          },
          idempotency_key: "test",
        },
        WALLET_A,
      ),
    ).rejects.toThrow("Expected chain_id 8453")
  })

  it("rejects sender mismatch", async () => {
    const deps = makeDeps()
    const service = new CreditPurchaseService(deps)

    try {
      await service.purchase(
        {
          pack_size: 1000,
          payment_proof: {
            tx_hash: "0xabc",
            chain_id: 8453,
            token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            sender: WALLET_B,
            amount_micro_usdc: "10000000",
          },
          idempotency_key: "test",
        },
        WALLET_A,
      )
      expect.unreachable("Should have thrown")
    } catch (e: any) {
      expect(e.code).toBe("SENDER_MISMATCH")
    }
  })

  it("rejects when RPC is unavailable", async () => {
    process.env.FINN_TREASURY_ADDRESS = TREASURY
    const deps = makeDeps({
      primaryClient: {
        getTransactionReceipt: vi.fn().mockRejectedValue(new Error("RPC down")),
        getBlockNumber: vi.fn().mockRejectedValue(new Error("RPC down")),
      } as any,
    })
    const service = new CreditPurchaseService(deps)

    try {
      await service.purchase(
        {
          pack_size: 1000,
          payment_proof: {
            tx_hash: "0xabc",
            chain_id: 8453,
            token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            sender: WALLET_A,
            amount_micro_usdc: "10000000",
          },
          idempotency_key: "test",
        },
        WALLET_A,
      )
      expect.unreachable("Should have thrown")
    } catch (e: any) {
      expect(e.code).toBe("VERIFICATION_UNAVAILABLE")
    } finally {
      delete process.env.FINN_TREASURY_ADDRESS
    }
  })

  it("rejects insufficient confirmations", async () => {
    process.env.FINN_TREASURY_ADDRESS = TREASURY
    const senderTopic = "0x" + "0".repeat(24) + WALLET_A.slice(2)
    const treasuryTopic = "0x" + "0".repeat(24) + TREASURY.slice(2)

    const deps = makeDeps({
      primaryClient: {
        getTransactionReceipt: vi.fn().mockResolvedValue({
          status: "success",
          blockNumber: 195n, // only 5 confirmations (200 - 195)
          blockHash: "0xblockhash123",
          logs: [
            {
              address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              topics: [
                "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                senderTopic,
                treasuryTopic,
              ],
              data: "0x" + (10_000_000n).toString(16).padStart(64, "0"),
              logIndex: 5,
            },
          ],
        }),
        getBlockNumber: vi.fn().mockResolvedValue(200n),
      } as any,
    })

    const service = new CreditPurchaseService(deps)

    try {
      await service.purchase(
        {
          pack_size: 1000,
          payment_proof: {
            tx_hash: "0xabc",
            chain_id: 8453,
            token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            sender: WALLET_A,
            amount_micro_usdc: "10000000",
          },
          idempotency_key: "test",
        },
        WALLET_A,
      )
      expect.unreachable("Should have thrown")
    } catch (e: any) {
      expect(e.code).toBe("PAYMENT_NOT_CONFIRMED")
    } finally {
      delete process.env.FINN_TREASURY_ADDRESS
    }
  })
})

// ---------------------------------------------------------------------------
// Task 2.5: Reorg Detection
// ---------------------------------------------------------------------------

describe("ReorgDetector", async () => {
  const { ReorgDetector } = await import("../../src/credits/reorg-detector.js")
  type StoredMint = import("../../src/credits/reorg-detector.js").StoredMint

  function makeMint(overrides?: Partial<StoredMint>): StoredMint {
    return {
      billing_entry_id: "01HWXYZ00000000000000ENTRY",
      tx_hash: "0xabc123",
      log_index: 5,
      block_number: 100n,
      block_hash: "0xblockhash_original",
      amount_micro_usdc: 10_000_000n,
      wallet_address: "0xwallet123",
      minted_at: Date.now() - 30 * 60 * 1000, // 30 min ago
      ...overrides,
    }
  }

  function makeDeps(overrides?: Partial<any>) {
    const walEntries: unknown[] = []
    const frozenWallets: string[] = []
    const alerts: string[] = []

    return {
      primaryClient: {
        getBlock: vi.fn().mockResolvedValue({ hash: "0xblockhash_original" }),
        getTransactionReceipt: vi.fn().mockResolvedValue({
          status: "success",
          blockHash: "0xblockhash_new",
          blockNumber: 100n,
        }),
      } as any,
      fallbackClient: undefined,
      getRecentMints: vi.fn(async () => [makeMint()]),
      walAppend: vi.fn(async (_type: string, payload: unknown) => {
        walEntries.push({ type: _type, payload })
        return "offset"
      }),
      freezeCredits: vi.fn(async (wallet: string) => {
        frozenWallets.push(wallet)
      }),
      alertAdmin: vi.fn(async (msg: string) => {
        alerts.push(msg)
      }),
      _walEntries: walEntries,
      _frozenWallets: frozenWallets,
      _alerts: alerts,
      ...overrides,
    }
  }

  it("detects no reorg when block hashes match", async () => {
    const deps = makeDeps()
    const detector = new ReorgDetector(deps)
    const result = await detector.checkRecentMints()
    expect(result.checked).toBe(1)
    expect(result.reorgsDetected).toBe(0)
  })

  it("detects reorg when block hash changes", async () => {
    const deps = makeDeps({
      primaryClient: {
        getBlock: vi.fn().mockResolvedValue({ hash: "0xNEW_BLOCK_HASH" }),
        getTransactionReceipt: vi.fn().mockResolvedValue({
          status: "success",
          blockHash: "0xNEW_BLOCK_HASH",
          blockNumber: 100n,
        }),
      } as any,
    })
    const detector = new ReorgDetector(deps)
    const result = await detector.checkRecentMints()
    expect(result.checked).toBe(1)
    expect(result.reorgsDetected).toBe(1)
    // Tx still valid after reorg — should NOT freeze
    expect(result.creditsReverted).toBe(0)
  })

  it("freezes credits when tx no longer valid after reorg", async () => {
    const deps = makeDeps({
      primaryClient: {
        getBlock: vi.fn().mockResolvedValue({ hash: "0xNEW_BLOCK_HASH" }),
        getTransactionReceipt: vi.fn().mockRejectedValue(new Error("Tx not found")),
      } as any,
    })
    const detector = new ReorgDetector(deps)
    const result = await detector.checkRecentMints()
    expect(result.reorgsDetected).toBe(1)
    expect(result.creditsReverted).toBe(1)
    expect(deps._frozenWallets).toContain("0xwallet123")
    expect(deps._alerts.length).toBe(1)
  })

  it("freezes credits when tx failed after reorg", async () => {
    const deps = makeDeps({
      primaryClient: {
        getBlock: vi.fn().mockResolvedValue({ hash: "0xNEW_BLOCK_HASH" }),
        getTransactionReceipt: vi.fn().mockResolvedValue({
          status: "reverted",
          blockHash: "0xNEW_BLOCK_HASH",
          blockNumber: 100n,
        }),
      } as any,
    })
    const detector = new ReorgDetector(deps)
    const result = await detector.checkRecentMints()
    expect(result.creditsReverted).toBe(1)
  })

  it("handles empty recent mints", async () => {
    const deps = makeDeps({ getRecentMints: vi.fn(async () => []) })
    const detector = new ReorgDetector(deps)
    const result = await detector.checkRecentMints()
    expect(result.checked).toBe(0)
    expect(result.reorgsDetected).toBe(0)
  })

  it("counts errors without throwing", async () => {
    const deps = makeDeps({
      primaryClient: {
        getBlock: vi.fn().mockRejectedValue(new Error("RPC down")),
      } as any,
      fallbackClient: undefined,
    })
    const detector = new ReorgDetector(deps)
    const result = await detector.checkRecentMints()
    // When both RPCs fail, checkMint returns false (skip), not an error
    expect(result.checked).toBe(1)
    expect(result.reorgsDetected).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Task 2.6: Reconciliation
// ---------------------------------------------------------------------------

describe("ReconciliationService", async () => {
  const { ReconciliationService } = await import("../../src/billing/reconciliation.js")
  const { Ledger, userAvailableAccount, SYSTEM_REVENUE } = await import("../../src/billing/ledger.js")

  function makeDeps(overrides?: Partial<any>) {
    const walEntries: unknown[] = []
    const redisStore = new Map<string, string>()
    const divergenceAlerts: unknown[] = []
    const driftAlerts: unknown[] = []

    return {
      getAllJournalEntries: vi.fn(async () => []),
      redisGet: vi.fn(async (key: string) => redisStore.get(key) ?? null),
      redisSet: vi.fn(async (key: string, value: string) => {
        redisStore.set(key, value)
      }),
      walAppend: vi.fn(async (_type: string, payload: unknown) => {
        walEntries.push(payload)
        return "offset"
      }),
      alertDivergence: vi.fn(async (details: unknown) => {
        divergenceAlerts.push(details)
      }),
      alertRoundingDrift: vi.fn(async (details: unknown) => {
        driftAlerts.push(details)
      }),
      _walEntries: walEntries,
      _redisStore: redisStore,
      _divergenceAlerts: divergenceAlerts,
      _driftAlerts: driftAlerts,
      ...overrides,
    }
  }

  it("reconciles with zero entries", async () => {
    const deps = makeDeps()
    const service = new ReconciliationService(deps)
    const result = await service.reconcile()
    expect(result.accounts_checked).toBe(0)
    expect(result.divergences_found).toBe(0)
  })

  it("detects divergence and corrects Redis", async () => {
    const deps = makeDeps({
      getAllJournalEntries: vi.fn(async () => [
        {
          billing_entry_id: "01HWXYZ00000000000000ENTRY" as any,
          event_type: "credit_mint" as const,
          correlation_id: "test",
          postings: [
            { account: userAvailableAccount("wallet1"), delta: 1000n, denom: "CreditUnit" as const },
            { account: SYSTEM_REVENUE, delta: -1000n, denom: "CreditUnit" as const },
          ],
          exchange_rate: null,
          rounding_direction: null,
          wal_offset: "offset",
          timestamp: Date.now(),
        },
      ]),
    })
    // Redis has wrong balance
    deps._redisStore.set(`balance:${userAvailableAccount("wallet1")}:value`, "500")

    const service = new ReconciliationService(deps)
    const result = await service.reconcile()

    expect(result.accounts_checked).toBe(2) // wallet + system:revenue
    expect(result.divergences_found).toBe(2) // both diverge from Redis
    expect(result.divergences_corrected).toBe(2)
    // Redis should be corrected
    expect(deps._redisStore.get(`balance:${userAvailableAccount("wallet1")}:value`)).toBe("1000")
  })

  it("no divergence when Redis matches derived", async () => {
    const account = userAvailableAccount("wallet1")
    const deps = makeDeps({
      getAllJournalEntries: vi.fn(async () => [
        {
          billing_entry_id: "01HWXYZ00000000000000ENTRY" as any,
          event_type: "credit_mint" as const,
          correlation_id: "test",
          postings: [
            { account, delta: 500n, denom: "CreditUnit" as const },
          ],
          exchange_rate: null,
          rounding_direction: null,
          wal_offset: "offset",
          timestamp: Date.now(),
        },
      ]),
    })
    deps._redisStore.set(`balance:${account}:value`, "500")

    const service = new ReconciliationService(deps)
    const result = await service.reconcile()

    expect(result.divergences_found).toBe(0)
  })

  it("logs reconciliation to WAL", async () => {
    const deps = makeDeps()
    const service = new ReconciliationService(deps)
    await service.reconcile()
    expect(deps._walEntries.length).toBe(1)
    expect((deps._walEntries[0] as any).accounts_checked).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Conservation guard integration (post-mint)
// ---------------------------------------------------------------------------

describe("Conservation guard post-mint", () => {
  it("credit mint postings sum to zero (conservation invariant)", async () => {
    const { creditMintPostings } = await import("../../src/billing/ledger.js")
    const { parseMicroUSD } = await import("../../src/hounfour/wire-boundary.js")

    const amount = parseMicroUSD("10000000") // $10
    const postings = creditMintPostings("wallet1", amount)

    const sum = postings.reduce((acc, p) => acc + p.delta, 0n)
    expect(sum).toBe(0n)
  })
})
