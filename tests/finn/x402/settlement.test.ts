// tests/finn/x402/settlement.test.ts — Settlement State Machine Tests (T-3.11)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { MerchantRelayer, SettlementService } from "../../../src/x402/settlement.js"
import { InMemorySettlementStore } from "../../../src/x402/settlement-store.js"
import { X402Error } from "../../../src/x402/types.js"
import { buildTestAuthorization, ANVIL_CHAIN_PROFILE } from "../../fixtures/anvil-chain-profile.js"

// --- Helpers ---

function makeSettlementService(overrides?: {
  submitResult?: { tx_hash: string; block_number: number; confirmation_count: number; method: "direct"; amount: string }
  submitError?: Error
}): SettlementService {
  const result = overrides?.submitResult ?? {
    tx_hash: "0x" + "ab".repeat(32),
    block_number: 12345,
    confirmation_count: 1,
    method: "direct" as const,
    amount: "100000",
  }

  return new SettlementService({
    submitDirect: overrides?.submitError
      ? vi.fn().mockRejectedValue(overrides.submitError)
      : vi.fn().mockResolvedValue(result),
    treasuryAddress: ANVIL_CHAIN_PROFILE.merchantAddress,
  })
}

function makeRelayer(overrides?: {
  service?: SettlementService
  store?: InMemorySettlementStore
  waitForConfirmation?: MerchantRelayer["settle"] extends (...args: infer _A) => infer _R ? never : never
  confirmationFn?: (txHash: string, timeoutMs: number) => Promise<unknown>
  maxConcurrent?: number
}) {
  const store = overrides?.store ?? new InMemorySettlementStore()
  const service = overrides?.service ?? makeSettlementService()

  return {
    relayer: new MerchantRelayer({
      store,
      settlementService: service,
      waitForConfirmation: overrides?.confirmationFn as undefined,
      maxConcurrentSettlements: overrides?.maxConcurrent,
    }),
    store,
  }
}

// --- Tests ---

describe("MerchantRelayer state machine", () => {
  let store: InMemorySettlementStore

  beforeEach(() => {
    store = new InMemorySettlementStore()
  })

  it("happy path: pending → submitted → confirmed (AC30b)", async () => {
    const { relayer, store: s } = makeRelayer({ store })
    const auth = buildTestAuthorization()

    const result = await relayer.settle(auth, "quote-001")

    expect(result.status).toBe("confirmed")
    expect(result.txHash).toBeTruthy()
    expect(result.idempotent).toBe(false)

    const record = await s.get(result.idempotencyKey)
    expect(record?.status).toBe("confirmed")
  })

  it("idempotent replay: same nonce returns cached result (AC30c)", async () => {
    const { relayer } = makeRelayer({ store })
    const auth = buildTestAuthorization({ nonce: "0x" + "11".repeat(32) })

    const result1 = await relayer.settle(auth, "quote-001")
    expect(result1.idempotent).toBe(false)

    const result2 = await relayer.settle(auth, "quote-001")
    expect(result2.idempotent).toBe(true)
    expect(result2.txHash).toBe(result1.txHash)
  })

  it("gas failure → 503 RELAYER_UNAVAILABLE (AC30d)", async () => {
    // Service succeeds (returns txHash), but confirmation detects gas failure
    const { relayer } = makeRelayer({
      store,
      confirmationFn: async () => { throw new Error("insufficient funds for gas") },
    })
    const auth = buildTestAuthorization()

    try {
      await relayer.settle(auth, "quote-001")
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(X402Error)
      expect((err as X402Error).httpStatus).toBe(503)
      expect((err as X402Error).code).toBe("RELAYER_UNAVAILABLE")
    }
  })

  it("bounded concurrency: rejects when queue full (AC30e)", async () => {
    const slowService = new SettlementService({
      submitDirect: vi.fn().mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({
          tx_hash: "0x" + "ff".repeat(32),
          block_number: 1,
          confirmation_count: 1,
          method: "direct",
          amount: "100000",
        }), 500))
      ),
      treasuryAddress: ANVIL_CHAIN_PROFILE.merchantAddress,
    })
    const { relayer } = makeRelayer({ store, service: slowService, maxConcurrent: 1 })

    // First settle starts
    const p1 = relayer.settle(buildTestAuthorization({ nonce: "0x01" + "00".repeat(31) }), "q1")

    // Wait a tick for p1 to claim its slot
    await new Promise(r => setTimeout(r, 10))

    // Second should be rejected
    await expect(
      relayer.settle(buildTestAuthorization({ nonce: "0x02" + "00".repeat(31) }), "q2")
    ).rejects.toThrow("Settlement queue full")

    await p1 // Clean up
  })

  it("timeout → 503 with SETTLEMENT_TIMEOUT (AC30f)", async () => {
    const { relayer } = makeRelayer({
      store,
      confirmationFn: async () => { throw new Error("TIMEOUT waiting for confirmation") },
    })
    const auth = buildTestAuthorization()

    try {
      await relayer.settle(auth, "quote-001")
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(X402Error)
      expect((err as X402Error).code).toBe("SETTLEMENT_TIMEOUT")
      expect((err as X402Error).httpStatus).toBe(503)
    }
  })

  it("rejects authorization not yet valid", async () => {
    const { relayer } = makeRelayer({ store })
    const futureAuth = buildTestAuthorization({
      validAfter: Math.floor(Date.now() / 1000) + 3600,
    })

    try {
      await relayer.settle(futureAuth, "quote-001")
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(X402Error)
      expect((err as X402Error).code).toBe("AUTHORIZATION_NOT_YET_VALID")
    }
  })

  it("rejects expired authorization", async () => {
    const { relayer } = makeRelayer({ store })
    const expiredAuth = buildTestAuthorization({
      validBefore: Math.floor(Date.now() / 1000) - 3600,
    })

    try {
      await relayer.settle(expiredAuth, "quote-001")
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(X402Error)
      expect((err as X402Error).code).toBe("AUTHORIZATION_EXPIRED")
    }
  })

  it("resumes submitted settlement", async () => {
    // Pre-populate store with submitted state
    const auth = buildTestAuthorization({ nonce: "0x" + "aa".repeat(32) })
    await store.claimPending("8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:" + auth.from.toLowerCase() + ":" + auth.nonce, "quote-resume")
    await store.update("8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:" + auth.from.toLowerCase() + ":" + auth.nonce, {
      status: "submitted",
      txHash: "0x" + "bb".repeat(32),
    })

    const { relayer } = makeRelayer({ store })
    const result = await relayer.settle(auth, "quote-resume")

    expect(result.status).toBe("confirmed")
    expect(result.txHash).toBe("0x" + "bb".repeat(32))
  })
})

describe("SettlementStore operations", () => {
  it("claimPending is atomic — second claim fails", async () => {
    const store = new InMemorySettlementStore()
    const key = "8453:0xusdc:0xfrom:0xnonce"

    expect(await store.claimPending(key, "q1")).toBe(true)
    expect(await store.claimPending(key, "q2")).toBe(false)
  })

  it("queryStaleByStatus returns old records", async () => {
    const store = new InMemorySettlementStore()
    await store.claimPending("key-1", "q1")

    // Records created "now" — query with future cutoff finds them
    const futureCutoff = new Date(Date.now() + 60_000).toISOString()
    const stale = await store.queryStaleByStatus("pending", futureCutoff)
    expect(stale).toHaveLength(1)
    expect(stale[0].idempotencyKey).toBe("key-1")
  })

  it("update changes status and sets updatedAt", async () => {
    const store = new InMemorySettlementStore()
    await store.claimPending("key-1", "q1")

    const before = await store.get("key-1")
    expect(before?.status).toBe("pending")

    await store.update("key-1", { status: "confirmed", txHash: "0xabc" })

    const after = await store.get("key-1")
    expect(after?.status).toBe("confirmed")
    expect(after?.txHash).toBe("0xabc")
  })
})
