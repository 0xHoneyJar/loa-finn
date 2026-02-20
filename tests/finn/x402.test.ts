// tests/finn/x402.test.ts — x402 Middleware + Payment Verification Tests (Sprint 8 Task 8.5)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { QuoteService } from "../../src/x402/middleware.js"
import { PaymentVerifier } from "../../src/x402/verify.js"
import { SettlementService } from "../../src/x402/settlement.js"
import { x402Routes } from "../../src/gateway/x402-routes.js"
import { AllowlistService } from "../../src/gateway/allowlist.js"
import { FeatureFlagService } from "../../src/gateway/feature-flags.js"
import { X402Error, BASE_CHAIN_ID } from "../../src/x402/types.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function createMockRedis(): RedisCommandClient {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...args: (string | number)[]) => {
      // Support SET key value EX ttl NX
      const hasNX = args.some(a => String(a).toUpperCase() === "NX")
      if (hasNX && store.has(key)) {
        return null // Key exists, NX prevents overwrite
      }
      store.set(key, value)
      return "OK"
    }),
    del: vi.fn(async (key: string) => { store.delete(key); return 1 }),
    incrby: vi.fn(async (key: string, val: number) => {
      const curr = parseInt(store.get(key) ?? "0", 10)
      const next = curr + val
      store.set(key, String(next))
      return next
    }),
    expire: vi.fn(async () => true),
    eval: vi.fn(async () => null),
    hgetall: vi.fn(async () => null),
  } as unknown as RedisCommandClient
}

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

const TREASURY = "0xTREASURY1234567890123456789012345678"
let quoteCounter = 0

function createQuoteService(redis: RedisCommandClient) {
  return new QuoteService({
    redis,
    treasuryAddress: TREASURY,
    ratePerToken: { "claude-sonnet-4-6": "15", "claude-haiku-4-5": "5" },
    markupFactor: 1.0,
    generateId: () => { quoteCounter++; return `q_${quoteCounter}` },
  })
}

function createMockAuth(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    from: "0xPAYER12345678901234567890123456789012",
    to: TREASURY,
    value: "61440", // enough for 4096 tokens at 15 MicroUSDC/token
    valid_after: 0,
    valid_before: Math.floor(Date.now() / 1000) + 600,
    nonce: `nonce_${Date.now()}`,
    v: 28,
    r: "0x" + "ab".repeat(32),
    s: "0x" + "cd".repeat(32),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. Quote Generation
// ---------------------------------------------------------------------------

describe("QuoteService", () => {
  let redis: RedisCommandClient
  let quoteService: QuoteService

  beforeEach(() => {
    quoteCounter = 0
    redis = createMockRedis()
    quoteService = createQuoteService(redis)
  })

  it("generates quote with correct max_cost", async () => {
    const quote = await quoteService.generateQuote({ model: "claude-sonnet-4-6", max_tokens: 4096 })
    expect(quote.max_cost).toBe("61440") // 4096 * 15 = 61440
    expect(quote.model).toBe("claude-sonnet-4-6")
    expect(quote.max_tokens).toBe(4096)
    expect(quote.chain_id).toBe(BASE_CHAIN_ID)
    expect(quote.payment_address).toBe(TREASURY)
    expect(quote.quote_id).toBe("q_1")
  })

  it("each call generates a unique quote (no cross-user cache sharing)", async () => {
    const q1 = await quoteService.generateQuote({ model: "claude-sonnet-4-6", max_tokens: 4096 })
    const q2 = await quoteService.generateQuote({ model: "claude-sonnet-4-6", max_tokens: 4096 })
    expect(q1.quote_id).not.toBe(q2.quote_id) // Each call gets a unique quote_id
    expect(q1.max_cost).toBe(q2.max_cost) // Same pricing
  })

  it("different max_tokens produces different quote", async () => {
    const q1 = await quoteService.generateQuote({ model: "claude-sonnet-4-6", max_tokens: 2048 })
    const q2 = await quoteService.generateQuote({ model: "claude-sonnet-4-6", max_tokens: 4096 })
    expect(q1.max_cost).not.toBe(q2.max_cost)
  })

  it("retrieves quote by ID", async () => {
    const generated = await quoteService.generateQuote({ model: "claude-sonnet-4-6" })
    const retrieved = await quoteService.getQuote(generated.quote_id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.quote_id).toBe(generated.quote_id)
  })

  it("returns null for unknown quote ID", async () => {
    const result = await quoteService.getQuote("nonexistent")
    expect(result).toBeNull()
  })

  it("applies markup factor", async () => {
    const service = new QuoteService({
      redis,
      treasuryAddress: TREASURY,
      ratePerToken: { "claude-sonnet-4-6": "100" },
      markupFactor: 1.1, // 10% markup
      generateId: () => "q_markup",
    })

    const quote = await service.generateQuote({ model: "claude-sonnet-4-6", max_tokens: 100 })
    // 100 * 100 = 10000, * 1.1 = 11000
    expect(BigInt(quote.max_cost)).toBe(11000n)
  })
})

// ---------------------------------------------------------------------------
// 2. Payment Verification
// ---------------------------------------------------------------------------

describe("PaymentVerifier", () => {
  let redis: RedisCommandClient
  let verifier: PaymentVerifier

  beforeEach(() => {
    redis = createMockRedis()
    verifier = new PaymentVerifier({
      redis,
      treasuryAddress: TREASURY,
      verifyEOASignature: async () => true,
    })
  })

  it("verifies valid payment", async () => {
    const auth = createMockAuth()
    const quote = { max_cost: "61440", quote_id: "q_1" }

    const result = await verifier.verify(
      { quote_id: "q_1", authorization: auth as any, chain_id: BASE_CHAIN_ID },
      quote as any,
    )

    expect(result.valid).toBe(true)
    expect(result.payment_id).toBeTruthy()
    expect(result.idempotent_replay).toBe(false)
  })

  it("rejects insufficient payment", async () => {
    const auth = createMockAuth({ value: "100" }) // way less than 61440
    const quote = { max_cost: "61440", quote_id: "q_1" }

    await expect(
      verifier.verify(
        { quote_id: "q_1", authorization: auth as any, chain_id: BASE_CHAIN_ID },
        quote as any,
      ),
    ).rejects.toThrow("Insufficient payment")
  })

  it("rejects expired authorization", async () => {
    const auth = createMockAuth({
      valid_before: Math.floor(Date.now() / 1000) - 100, // already expired
    })
    const quote = { max_cost: "61440", quote_id: "q_1" }

    await expect(
      verifier.verify(
        { quote_id: "q_1", authorization: auth as any, chain_id: BASE_CHAIN_ID },
        quote as any,
      ),
    ).rejects.toThrow("expired")
  })

  it("rejects invalid recipient", async () => {
    const auth = createMockAuth({ to: "0xWRONGADDRESS" })
    const quote = { max_cost: "61440", quote_id: "q_1" }

    await expect(
      verifier.verify(
        { quote_id: "q_1", authorization: auth as any, chain_id: BASE_CHAIN_ID },
        quote as any,
      ),
    ).rejects.toThrow("treasury")
  })

  it("rejects invalid signature", async () => {
    const badVerifier = new PaymentVerifier({
      redis,
      treasuryAddress: TREASURY,
      verifyEOASignature: async () => false,
    })

    const auth = createMockAuth()
    const quote = { max_cost: "61440", quote_id: "q_1" }

    await expect(
      badVerifier.verify(
        { quote_id: "q_1", authorization: auth as any, chain_id: BASE_CHAIN_ID },
        quote as any,
      ),
    ).rejects.toThrow("Invalid payment signature")
  })

  it("detects nonce replay (idempotent)", async () => {
    const auth = createMockAuth()
    const quote = { max_cost: "61440", quote_id: "q_1" }
    const proof = { quote_id: "q_1", authorization: auth as any, chain_id: BASE_CHAIN_ID }

    // First verification
    const first = await verifier.verify(proof, quote as any)
    expect(first.idempotent_replay).toBe(false)

    // Second with same nonce — idempotent replay
    const second = await verifier.verify(proof, quote as any)
    expect(second.idempotent_replay).toBe(true)
  })

  it("smart wallet (EIP-1271) fallback verification", async () => {
    const smartVerifier = new PaymentVerifier({
      redis,
      treasuryAddress: TREASURY,
      verifyEOASignature: async () => false, // EOA fails
      verifyContractSignature: async () => true, // EIP-1271 succeeds
    })

    const auth = createMockAuth()
    const quote = { max_cost: "61440", quote_id: "q_1" }

    const result = await smartVerifier.verify(
      { quote_id: "q_1", authorization: auth as any, chain_id: BASE_CHAIN_ID },
      quote as any,
    )
    expect(result.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. Settlement
// ---------------------------------------------------------------------------

describe("SettlementService", () => {
  it("uses facilitator as primary", async () => {
    const service = new SettlementService({
      treasuryAddress: TREASURY,
      submitToFacilitator: async () => ({
        tx_hash: "0xabc",
        block_number: 100,
        confirmation_count: 3,
        method: "facilitator" as const,
        amount: "61440",
      }),
    })

    const auth = createMockAuth()
    const result = await service.settle(auth as any, "q_1")
    expect(result.method).toBe("facilitator")
    expect(result.tx_hash).toBe("0xabc")
  })

  it("falls back to direct on facilitator failure", async () => {
    const service = new SettlementService({
      treasuryAddress: TREASURY,
      submitToFacilitator: async () => { throw new Error("facilitator down") },
      submitDirect: async () => ({
        tx_hash: "0xdef",
        block_number: 101,
        confirmation_count: 3,
        method: "direct" as const,
        amount: "61440",
      }),
    })

    const auth = createMockAuth()
    const result = await service.settle(auth as any, "q_1")
    expect(result.method).toBe("direct")
  })

  it("fails when both methods unavailable", async () => {
    const service = new SettlementService({
      treasuryAddress: TREASURY,
      submitToFacilitator: async () => { throw new Error("down") },
      submitDirect: async () => { throw new Error("also down") },
    })

    const auth = createMockAuth()
    await expect(service.settle(auth as any, "q_1")).rejects.toThrow("Settlement failed")
  })

  it("circuit breaker opens after 3 failures", async () => {
    let callCount = 0
    const service = new SettlementService({
      treasuryAddress: TREASURY,
      submitToFacilitator: async () => {
        callCount++
        throw new Error("fail")
      },
      submitDirect: async () => ({
        tx_hash: "0xfallback",
        block_number: 102,
        confirmation_count: 3,
        method: "direct" as const,
        amount: "61440",
      }),
    })

    const auth = createMockAuth()

    // 3 failures trigger circuit breaker
    await service.settle(auth as any, "q_1") // fail → fallback
    await service.settle(auth as any, "q_2") // fail → fallback
    await service.settle(auth as any, "q_3") // fail → fallback, circuit opens

    // After 3 failures, facilitator is skipped
    callCount = 0
    await service.settle(auth as any, "q_4") // circuit open → direct only
    expect(callCount).toBe(0) // facilitator not called
    expect(service.circuitState).toBe("OPEN")
  })
})

// ---------------------------------------------------------------------------
// 4. x402 Routes
// ---------------------------------------------------------------------------

describe("x402Routes", () => {
  let redis: RedisCommandClient
  let app: ReturnType<typeof x402Routes>

  beforeEach(async () => {
    quoteCounter = 0
    redis = createMockRedis()
    const allowlist = new AllowlistService({ redis })
    const flags = new FeatureFlagService({ redis })
    await flags.setFlag("x402", true)
    await allowlist.addAddresses(["0xPAYER12345678901234567890123456789012"])

    app = x402Routes({
      redis,
      quoteService: createQuoteService(redis),
      paymentVerifier: new PaymentVerifier({
        redis,
        treasuryAddress: TREASURY,
        verifyEOASignature: async () => true,
      }),
      settlementService: new SettlementService({
        treasuryAddress: TREASURY,
        submitToFacilitator: async () => ({
          tx_hash: "0xsettled",
          block_number: 200,
          confirmation_count: 3,
          method: "facilitator" as const,
          amount: "61440",
        }),
      }),
      allowlistService: allowlist,
      featureFlagService: flags,
      executeInference: async () => "Hello from x402!",
    })
  })

  it("returns 402 with quote when no payment header", async () => {
    const resp = await app.request("/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Hello", model: "claude-sonnet-4-6" }),
    })
    expect(resp.status).toBe(402)
    const body = await resp.json()
    expect(body.code).toBe("PAYMENT_REQUIRED")
    expect(body.quote).toBeTruthy()
    expect(body.quote.max_cost).toBeTruthy()
    expect(resp.headers.get("x-payment-required")).toBeTruthy()
  })

  it("rejects nft_id parameter", async () => {
    const resp = await app.request("/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Hello", nft_id: "0xABC:42" }),
    })
    expect(resp.status).toBe(400)
    const body = await resp.json()
    expect(body.code).toBe("NFT_NOT_SUPPORTED")
  })

  it("returns 503 when x402 feature disabled", async () => {
    const flags = new FeatureFlagService({ redis })
    await flags.setFlag("x402", false)

    const disabledApp = x402Routes({
      redis,
      quoteService: createQuoteService(redis),
      paymentVerifier: new PaymentVerifier({ redis, treasuryAddress: TREASURY }),
      settlementService: new SettlementService({ treasuryAddress: TREASURY }),
      allowlistService: new AllowlistService({ redis }),
      featureFlagService: flags,
      executeInference: async () => "no",
    })

    const resp = await disabledApp.request("/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Hello" }),
    })
    expect(resp.status).toBe(503)
  })

  it("rejects non-allowlisted wallet during beta", async () => {
    // Get a quote first
    const quoteResp = await app.request("/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Hello", model: "claude-sonnet-4-6" }),
    })
    const { quote } = await quoteResp.json()

    const auth = createMockAuth({
      from: "0xNOTALLOWED000000000000000000000000000",
    })

    const resp = await app.request("/invoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Payment": JSON.stringify({ quote_id: quote.quote_id, authorization: auth, chain_id: BASE_CHAIN_ID }),
      },
      body: JSON.stringify({ prompt: "Hello" }),
    })
    expect(resp.status).toBe(403)
    const body = await resp.json()
    expect(body.code).toBe("NOT_ALLOWLISTED")
  })
})

// ---------------------------------------------------------------------------
// 5. Module Exports
// ---------------------------------------------------------------------------

describe("x402 module exports", () => {
  it("types exports", async () => {
    const mod = await import("../../src/x402/types.js")
    expect(mod.X402Error).toBeDefined()
    expect(mod.BASE_CHAIN_ID).toBe(8453)
  })

  it("middleware exports", async () => {
    const mod = await import("../../src/x402/middleware.js")
    expect(mod.QuoteService).toBeDefined()
  })

  it("verify exports", async () => {
    const mod = await import("../../src/x402/verify.js")
    expect(mod.PaymentVerifier).toBeDefined()
  })

  it("settlement exports", async () => {
    const mod = await import("../../src/x402/settlement.js")
    expect(mod.SettlementService).toBeDefined()
  })

  it("x402-routes exports", async () => {
    const mod = await import("../../src/gateway/x402-routes.js")
    expect(mod.x402Routes).toBeDefined()
  })
})
