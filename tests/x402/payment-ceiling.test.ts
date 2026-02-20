// tests/x402/payment-ceiling.test.ts — Payment Ceiling Tests (Sprint 120 T3.3)

import { describe, it, expect, beforeEach, vi } from "vitest"
import { PaymentVerifier } from "../../src/x402/verify.js"
import type { VerifyDeps } from "../../src/x402/verify.js"
import type { X402Quote, PaymentProof, EIP3009Authorization } from "../../src/x402/types.js"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockRedis() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(-1),
  }
}

function createAuth(overrides: Partial<EIP3009Authorization> = {}): EIP3009Authorization {
  return {
    from: "0xSender",
    to: "0xTreasury",
    value: "1000000", // 1 USDC
    valid_after: 0,
    valid_before: Math.floor(Date.now() / 1000) + 3600,
    nonce: "0xnonce123",
    signature: "0xsig",
    ...overrides,
  }
}

function createProof(overrides: Partial<PaymentProof> = {}): PaymentProof {
  return {
    authorization: createAuth(overrides.authorization as any),
    chain_id: 8453,
    quote_id: "q_test",
    ...overrides,
  }
}

function createQuote(overrides: Partial<X402Quote> = {}): X402Quote {
  return {
    max_cost: "1000000",
    token_address: "0xUSDC",
    chain_id: 8453,
    recipient: "0xTreasury",
    valid_until: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  } as X402Quote
}

function createDeps(overrides: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    redis: createMockRedis() as any,
    treasuryAddress: "0xTreasury",
    verifyEOASignature: async () => true,
    walAppend: vi.fn(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PaymentVerifier — payment ceiling (Bridge medium-7)", () => {
  it("rejects payment exceeding default ceiling (100 USDC)", async () => {
    const verifier = new PaymentVerifier(createDeps())
    const proof = createProof({
      authorization: { value: "200000000" } as any, // 200 USDC > 100 USDC ceiling
    })
    // Need to reconstruct with full auth
    const fullProof = createProof()
    fullProof.authorization.value = "200000000"
    const quote = createQuote({ max_cost: "100000000" })

    await expect(verifier.verify(fullProof, quote)).rejects.toThrow("exceeds ceiling")
  })

  it("accepts payment at exactly the ceiling", async () => {
    const verifier = new PaymentVerifier(createDeps())
    const proof = createProof()
    proof.authorization.value = "100000000" // exactly 100 USDC
    const quote = createQuote({ max_cost: "100000000" })

    const result = await verifier.verify(proof, quote)
    expect(result.valid).toBe(true)
  })

  it("accepts payment below the ceiling", async () => {
    const verifier = new PaymentVerifier(createDeps())
    const proof = createProof()
    proof.authorization.value = "5000000" // 5 USDC
    const quote = createQuote({ max_cost: "5000000" })

    const result = await verifier.verify(proof, quote)
    expect(result.valid).toBe(true)
  })

  it("uses custom ceiling from deps", async () => {
    const verifier = new PaymentVerifier(
      createDeps({ maxPaymentAmount: 50_000_000 }), // 50 USDC
    )
    const proof = createProof()
    proof.authorization.value = "75000000" // 75 USDC > 50 USDC ceiling
    const quote = createQuote({ max_cost: "50000000" })

    await expect(verifier.verify(proof, quote)).rejects.toThrow("exceeds ceiling")
  })

  it("disables ceiling check when maxPaymentAmount is 0", async () => {
    const verifier = new PaymentVerifier(
      createDeps({ maxPaymentAmount: 0 }),
    )
    const proof = createProof()
    proof.authorization.value = "999999999999" // huge amount
    const quote = createQuote({ max_cost: "999999999999" })

    const result = await verifier.verify(proof, quote)
    expect(result.valid).toBe(true)
  })

  it("error includes PAYMENT_EXCEEDS_CEILING code", async () => {
    const verifier = new PaymentVerifier(createDeps())
    const proof = createProof()
    proof.authorization.value = "200000000"
    const quote = createQuote({ max_cost: "100000000" })

    try {
      await verifier.verify(proof, quote)
      expect.fail("should have thrown")
    } catch (err: any) {
      expect(err.code).toBe("PAYMENT_EXCEEDS_CEILING")
      expect(err.httpStatus).toBe(402)
    }
  })

  it("ceiling check runs before signature verification", async () => {
    // If ceiling check runs first, we should get PAYMENT_EXCEEDS_CEILING
    // even with a signature verifier that would reject
    const verifier = new PaymentVerifier(
      createDeps({
        verifyEOASignature: async () => false, // would fail sig check
        maxPaymentAmount: 10_000_000, // 10 USDC
      }),
    )
    const proof = createProof()
    proof.authorization.value = "50000000" // 50 USDC > 10 USDC ceiling
    const quote = createQuote({ max_cost: "10000000" })

    try {
      await verifier.verify(proof, quote)
      expect.fail("should have thrown")
    } catch (err: any) {
      // Should be ceiling error, not signature error
      expect(err.code).toBe("PAYMENT_EXCEEDS_CEILING")
    }
  })
})
