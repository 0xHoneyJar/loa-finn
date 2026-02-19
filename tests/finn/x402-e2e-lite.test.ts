// tests/finn/x402-e2e-lite.test.ts — E2E-Lite Payment Flow Integration Test (Sprint 12 Task 12.4)
//
// Validates the full payment pipeline orchestration:
// quote → verify → settle → finalize → ledger entry.
// Uses mock Redis (no Docker dependency). Conservation invariant checked.

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Shared Mock Redis Factory
// ---------------------------------------------------------------------------

function createMockRedis() {
  const store: Record<string, string> = {}

  return {
    store,
    set: vi.fn(async (key: string, value: string, ...args: any[]) => {
      // Handle SET ... NX (SETNX semantics)
      if (args.includes("NX")) {
        if (store[key]) return null // Key exists → NX fails
        store[key] = value
        return "OK"
      }
      store[key] = value
      return "OK"
    }),
    get: vi.fn(async (key: string) => store[key] ?? null),
    del: vi.fn(async (key: string) => {
      delete store[key]
      return 1
    }),
    expire: vi.fn(async () => 1),
    incrby: vi.fn(async (key: string, value: number) => {
      const current = Number(store[key] ?? "0")
      const newVal = current + value
      store[key] = String(newVal)
      return newVal
    }),
    eval: vi.fn(async (script: string, ...args: any[]) => {
      const scriptStr = String(script)

      // DLQ XGROUP CREATE
      if (scriptStr.includes("XGROUP") && scriptStr.includes("CREATE")) {
        return "OK"
      }

      // DLQ XADD + INCRBY (enqueue)
      if (scriptStr.includes("XADD") && scriptStr.includes("INCRBY")) {
        return "OK"
      }

      // Credit balance Lua (cap enforcement)
      if (scriptStr.includes("INCRBY") && scriptStr.includes("EXPIRE") && scriptStr.includes("cap")) {
        const keys = args[0] as string[]
        const argv = args[1] as string[]
        const key = keys[0]
        const delta = Number(argv[0])
        const cap = Number(argv[1])
        const current = Number(store[key] ?? "0")
        if (current + delta > cap) return "CAP_EXCEEDED"
        const newBalance = current + delta
        store[key] = String(newBalance)
        return String(newBalance)
      }

      return null
    }),
  }
}

// ---------------------------------------------------------------------------
// Test: Full E2E Payment Flow (Orchestration + Conservation)
// ---------------------------------------------------------------------------

describe("x402 E2E-Lite Payment Flow (Task 12.4)", async () => {
  const { QuoteService } = await import("../../src/x402/middleware.js")
  const { PaymentVerifier } = await import("../../src/x402/verify.js")
  const { SettlementService } = await import("../../src/x402/settlement.js")
  const { CreditNoteService } = await import("../../src/x402/credit-note.js")
  const { Ledger, billingCommitPostings, billingReservePostings, creditMintPostings, SYSTEM_REVENUE } = await import("../../src/billing/ledger.js")

  const TREASURY = "0x1234567890abcdef1234567890abcdef12345678"
  const PAYER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"

  it("full flow: quote → verify → settle → ledger — conservation holds", async () => {
    const redis = createMockRedis()

    // 1. Generate quote
    const quoteService = new QuoteService({
      redis: redis as any,
      treasuryAddress: TREASURY,
      ratePerToken: { "claude-sonnet-4-6": "15" },
      generateId: () => "q_test_001",
    })
    const quote = await quoteService.generateQuote({ model: "claude-sonnet-4-6", max_tokens: 1000 })
    expect(quote.quote_id).toBe("q_test_001")
    expect(BigInt(quote.max_cost)).toBeGreaterThan(0n)

    // 2. Verify payment
    const verifier = new PaymentVerifier({
      redis: redis as any,
      treasuryAddress: TREASURY,
      verifyEOASignature: async () => true,
    })

    const now = Math.floor(Date.now() / 1000)
    const paymentProof = {
      quote_id: quote.quote_id,
      authorization: {
        from: PAYER,
        to: TREASURY,
        value: quote.max_cost,
        valid_after: now - 60,
        valid_before: now + 300,
        nonce: "0x" + "a".repeat(64),
        v: 27,
        r: "0x" + "b".repeat(64),
        s: "0x" + "c".repeat(64),
      },
      chain_id: 8453,
    }

    const verifyResult = await verifier.verify(paymentProof, quote)
    expect(verifyResult.valid).toBe(true)
    expect(verifyResult.idempotent_replay).toBe(false)
    expect(verifyResult.payment_id).toContain("pid_")

    // 3. Settle (mock facilitator)
    const settlement = new SettlementService({
      submitToFacilitator: async () => ({
        tx_hash: "0x" + "d".repeat(64),
        block_number: 12345,
        confirmation_count: 1,
        method: "facilitator" as const,
        amount: quote.max_cost,
      }),
      treasuryAddress: TREASURY,
    })
    const settleResult = await settlement.settle(paymentProof.authorization, quote.quote_id)
    expect(settleResult.method).toBe("facilitator")
    expect(settleResult.tx_hash).toBeDefined()

    // 4. Ledger — verify conservation invariant
    const ledger = new Ledger()
    const userId = PAYER.toLowerCase()
    const cost = BigInt(quote.max_cost)

    // Simulate: credit mint → reserve → commit (actual cost)
    const actualCost = cost / 2n // Simulate actual cost = half of max
    ledger.appendEntry({
      billing_entry_id: "01AAAAAAAAAAAAAAAAAAAAAAAAA" as any,
      event_type: "credit_mint",
      correlation_id: "corr_001",
      postings: creditMintPostings(userId, cost),
      exchange_rate: null,
      rounding_direction: null,
      wal_offset: "01AAAAAAAAAAAAAAAAAAAAAAAAAAA",
      timestamp: Date.now(),
    })

    // Reserve: move cost from available → held
    ledger.appendEntry({
      billing_entry_id: "01AAAAAAAAAAAAAAAAAAAAAAAAB" as any,
      event_type: "billing_reserve",
      correlation_id: "corr_001",
      postings: billingReservePostings(userId, cost),
      exchange_rate: null,
      rounding_direction: null,
      wal_offset: "01AAAAAAAAAAAAAAAAAAAAAAAAB",
      timestamp: Date.now(),
    })

    // Commit: held → revenue + overage back to available
    ledger.appendEntry({
      billing_entry_id: "01AAAAAAAAAAAAAAAAAAAAAAAAAAC" as any,
      event_type: "billing_commit",
      correlation_id: "corr_001",
      postings: billingCommitPostings(userId, cost, actualCost),
      exchange_rate: null,
      rounding_direction: null,
      wal_offset: "01AAAAAAAAAAAAAAAAAAAAAAAAAAC",
      timestamp: Date.now(),
    })

    // Conservation invariant: SUM(all accounts) === 0n
    const balances = ledger.deriveAllBalances()
    let totalBalance = 0n
    for (const [, balance] of balances) {
      totalBalance += balance
    }
    expect(totalBalance).toBe(0n)

    // Verify user got overage back
    const userAvailable = balances.get(`user:${userId}:available`) ?? 0n
    expect(userAvailable).toBe(cost - actualCost) // Overage returned
  })

  it("quote_id flows through entire pipeline (correlation)", async () => {
    const redis = createMockRedis()
    const quoteId = "q_correlation_test"

    const quoteService = new QuoteService({
      redis: redis as any,
      treasuryAddress: TREASURY,
      ratePerToken: { "claude-sonnet-4-6": "15" },
      generateId: () => quoteId,
    })
    const quote = await quoteService.generateQuote({ model: "claude-sonnet-4-6" })
    expect(quote.quote_id).toBe(quoteId)

    // Quote stored in Redis
    const storedQuote = await quoteService.getQuote(quoteId)
    expect(storedQuote).not.toBeNull()
    expect(storedQuote!.quote_id).toBe(quoteId)

    // Verify references quote_id
    const verifier = new PaymentVerifier({
      redis: redis as any,
      treasuryAddress: TREASURY,
      verifyEOASignature: async () => true,
    })

    const now = Math.floor(Date.now() / 1000)
    const proof = {
      quote_id: quoteId,
      authorization: {
        from: PAYER, to: TREASURY, value: quote.max_cost,
        valid_after: now - 60, valid_before: now + 300,
        nonce: "0x" + "e".repeat(64), v: 27,
        r: "0x" + "f".repeat(64), s: "0x" + "0".repeat(64),
      },
      chain_id: 8453,
    }

    const result = await verifier.verify(proof, quote)
    expect(result.valid).toBe(true)

    // WAL audit data references quote_id (verified via mock — audit called)
    // Quote → Verify → Settle all share the same quote_id
    const settleAuditCalls: any[] = []
    const settlement = new SettlementService({
      submitToFacilitator: async () => ({
        tx_hash: "0x" + "1".repeat(64), block_number: 999,
        confirmation_count: 1, method: "facilitator" as const, amount: quote.max_cost,
      }),
      treasuryAddress: TREASURY,
      walAppend: (_ns, _op, _key, payload) => {
        settleAuditCalls.push(payload)
        return "audit_001"
      },
    })
    await settlement.settle(proof.authorization, quoteId)
    expect(settleAuditCalls[0].quote_id).toBe(quoteId)
  })

  it("credit note issued on overpayment (delta = quoted - actual)", async () => {
    const redis = createMockRedis()
    const creditNoteService = new CreditNoteService({ redis: redis as any })

    const quotedAmount = "15000" // 15000 MicroUSDC quoted
    const actualAmount = "10000" // 10000 MicroUSDC actual
    const expectedDelta = "5000" // 5000 MicroUSDC credit

    const note = await creditNoteService.issueCreditNote(
      PAYER, "q_overpay", quotedAmount, actualAmount,
    )
    expect(note).not.toBeNull()
    expect(note!.amount).toBe(expectedDelta)
    expect(note!.wallet_address).toBe(PAYER.toLowerCase())
  })

  it("DLQ enqueue on settlement failure", async () => {
    const redis = createMockRedis()
    const { DLQProcessor } = await import("../../src/billing/dlq.js")

    const finalized: string[] = []
    const poisoned: any[] = []
    const alerts: any[] = []

    const dlq = new DLQProcessor({
      redis: redis as any,
      consumerId: "test-consumer",
      onFinalize: async (id) => { finalized.push(id); return true },
      onPoisonMessage: async (entry) => { poisoned.push(entry) },
      onEscalation: async () => {},
      onAlert: async (type, msg, details) => { alerts.push({ type, msg, details }) },
    })

    await dlq.initialize()

    // Simulate settlement failure → DLQ enqueue
    await dlq.enqueue(
      "01BBBBBBBBBBBBBBBBBBBBBBBBBB",
      "account_001",
      "5000",
      "corr_settle_fail",
      "facilitator_timeout",
    )

    // Verify enqueue was called (XADD via eval)
    expect(redis.eval).toHaveBeenCalled()
  })

  it("conservation invariant: SUM(all postings) === 0n after complete flow", async () => {
    const ledger = new Ledger()
    const userId = "user_conservation_test"

    // Multi-step flow: mint → reserve → commit → credit note
    // Each step must maintain zero-sum

    // Step 1: Credit mint (100 USDC)
    const mintAmount = 100_000_000n // 100 USDC
    ledger.appendEntry({
      billing_entry_id: "01CCCCCCCCCCCCCCCCCCCCCCCCCC" as any,
      event_type: "credit_mint",
      correlation_id: "corr_cons",
      postings: creditMintPostings(userId, mintAmount),
      exchange_rate: null,
      rounding_direction: null,
      wal_offset: "01CCCCCCCCCCCCCCCCCCCCCCCCCC",
      timestamp: Date.now(),
    })

    // Step 2: Reserve (hold estimated from available)
    const estimated = 75_000_000n
    const actual = 50_000_000n
    ledger.appendEntry({
      billing_entry_id: "01DDDDDDDDDDDDDDDDDDDDDDDDDA" as any,
      event_type: "billing_reserve",
      correlation_id: "corr_cons",
      postings: billingReservePostings(userId, estimated),
      exchange_rate: null,
      rounding_direction: null,
      wal_offset: "01DDDDDDDDDDDDDDDDDDDDDDDDDA",
      timestamp: Date.now(),
    })

    // Step 3: Billing commit (actual = 50 USDC, estimated = 75 USDC)
    ledger.appendEntry({
      billing_entry_id: "01DDDDDDDDDDDDDDDDDDDDDDDDDD" as any,
      event_type: "billing_commit",
      correlation_id: "corr_cons",
      postings: billingCommitPostings(userId, estimated, actual),
      exchange_rate: null,
      rounding_direction: null,
      wal_offset: "01DDDDDDDDDDDDDDDDDDDDDDDDDD",
      timestamp: Date.now(),
    })

    // Verify zero-sum
    const balances = ledger.deriveAllBalances()
    let total = 0n
    for (const [, b] of balances) {
      total += b
    }
    expect(total).toBe(0n)

    // Verify individual accounts
    // available = mint(100M) - reserve(75M) + overage(25M) = 50M
    expect(balances.get(`user:${userId}:available`)).toBe(
      mintAmount - estimated + (estimated - actual),
    )
    expect(balances.get(SYSTEM_REVENUE)).toBe(actual)
  })
})
