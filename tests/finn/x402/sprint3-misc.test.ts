// tests/finn/x402/sprint3-misc.test.ts — Sprint 3 Misc Tests (T-3.11)
//
// Tests for: chain binding, MicroUSDC branded type, gas surcharge,
// conservation guard x402 mode, relayer monitor, reconciliation.

import { describe, it, expect, vi } from "vitest"

// --- T-3.4: MicroUSDC Branded Type ---

import { toMicroUSDC, isMicroUSDC } from "../../../src/x402/denomination.js"

describe("MicroUSDC branded type (T-3.4)", () => {
  it("creates branded MicroUSDC from bigint", () => {
    const val = toMicroUSDC(100000n)
    expect(typeof val).toBe("bigint")
    expect(val).toBe(100000n)
  })

  it("rejects negative values", () => {
    expect(() => toMicroUSDC(-1n)).toThrow("cannot be negative")
  })

  it("isMicroUSDC returns true for non-negative", () => {
    expect(isMicroUSDC(0n)).toBe(true)
    expect(isMicroUSDC(100n)).toBe(true)
  })
})

// --- T-3.5: Gas Surcharge ---

import { computeQuoteWithGas, getRequestCostWithGas, resetPricingCache } from "../../../src/x402/pricing.js"

describe("Gas surcharge (T-3.5)", () => {
  it("adds 5% surcharge by default", () => {
    // 100000 * 0.05 = 5000 surcharge
    const total = computeQuoteWithGas(100000n)
    expect(total).toBe("105000")
  })

  it("caps surcharge at 10000 MicroUSDC (0.01 USDC) (AC30g)", () => {
    // 1000000 * 0.05 = 50000 > 10000 cap
    const total = computeQuoteWithGas(1000000n)
    expect(total).toBe("1010000") // 1000000 + 10000 cap
  })

  it("supports custom surcharge rate", () => {
    const total = computeQuoteWithGas(100000n, 0.10) // 10%
    expect(total).toBe("110000")
  })

  it("getRequestCostWithGas includes surcharge", () => {
    resetPricingCache()
    // Default: 100000 + 5000 surcharge = 105000
    const total = getRequestCostWithGas("nft-1", "claude-opus-4-6", 4096)
    expect(BigInt(total)).toBe(105000n)
  })
})

// --- T-3.1: Chain Binding ---

import { PaymentVerifier } from "../../../src/x402/verify.js"
import { X402Error, BASE_CHAIN_ID } from "../../../src/x402/types.js"

function mockRedisForVerify() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
  } as any
}

describe("Chain binding (T-3.1)", () => {
  it("rejects wrong chainId (AC28b)", async () => {
    const verifier = new PaymentVerifier({
      redis: mockRedisForVerify(),
      treasuryAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      verifyEOASignature: async () => true,
    })

    const now = Math.floor(Date.now() / 1000)
    try {
      await verifier.verify(
        {
          quote_id: "q1",
          chain_id: 1, // Mainnet, not Base
          authorization: {
            from: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
            to: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            value: "100000",
            valid_after: now - 60,
            valid_before: now + 300,
            nonce: "0x01",
            v: 27, r: "0x" + "ab".repeat(32), s: "0x" + "cd".repeat(32),
          },
        },
        {
          max_cost: "100000", max_tokens: 4096, model: "claude-opus-4-6",
          payment_address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
          chain_id: 1, valid_until: now + 300,
          token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", quote_id: "q1",
        },
      )
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(X402Error)
      expect((err as X402Error).code).toBe("INVALID_CHAIN")
    }
  })

  it("rejects wrong token contract (AC28c)", async () => {
    const verifier = new PaymentVerifier({
      redis: mockRedisForVerify(),
      treasuryAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      verifyEOASignature: async () => true,
    })

    const now = Math.floor(Date.now() / 1000)
    try {
      await verifier.verify(
        {
          quote_id: "q1",
          chain_id: BASE_CHAIN_ID,
          authorization: {
            from: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
            to: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            value: "100000",
            valid_after: now - 60,
            valid_before: now + 300,
            nonce: "0x02",
            v: 27, r: "0x" + "ab".repeat(32), s: "0x" + "cd".repeat(32),
          },
        },
        {
          max_cost: "100000", max_tokens: 4096, model: "claude-opus-4-6",
          payment_address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
          chain_id: BASE_CHAIN_ID, valid_until: now + 300,
          token_address: "0xDAI_WRONG_TOKEN", quote_id: "q1",
        },
      )
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(X402Error)
      expect((err as X402Error).code).toBe("INVALID_TOKEN")
    }
  })

  it("rejects wrong recipient (AC28a)", async () => {
    const verifier = new PaymentVerifier({
      redis: mockRedisForVerify(),
      treasuryAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      verifyEOASignature: async () => true,
    })

    const now = Math.floor(Date.now() / 1000)
    try {
      await verifier.verify(
        {
          quote_id: "q1",
          chain_id: BASE_CHAIN_ID,
          authorization: {
            from: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
            to: "0xDEAD_WRONG_ADDRESS",
            value: "100000",
            valid_after: now - 60,
            valid_before: now + 300,
            nonce: "0x03",
            v: 27, r: "0x" + "ab".repeat(32), s: "0x" + "cd".repeat(32),
          },
        },
        {
          max_cost: "100000", max_tokens: 4096, model: "claude-opus-4-6",
          payment_address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
          chain_id: BASE_CHAIN_ID, valid_until: now + 300,
          token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", quote_id: "q1",
        },
      )
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(X402Error)
      expect((err as X402Error).code).toBe("INVALID_RECIPIENT")
    }
  })
})

// --- T-3.6: Conservation Guard x402 Mode ---

import { BillingConservationGuard } from "../../../src/hounfour/billing-conservation-guard.js"

describe("Conservation guard x402 mode (T-3.6)", () => {
  it("passes when payment >= cost (AC29)", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()

    const result = guard.checkX402Conservation(200000n, 100000n)
    expect(result.ok).toBe(true)
    expect(result.effective).toBe("pass")
  })

  it("fails when payment < cost (AC29)", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()

    const result = guard.checkX402Conservation(50000n, 100000n)
    expect(result.ok).toBe(false)
    expect(result.effective).toBe("fail")
  })

  it("passes when payment exactly equals cost", async () => {
    const guard = new BillingConservationGuard()
    await guard.init()

    const result = guard.checkX402Conservation(100000n, 100000n)
    expect(result.ok).toBe(true)
  })
})

// --- T-3.8: Relayer Monitor ---

import { RelayerMonitor, type BalanceProvider } from "../../../src/x402/relayer-monitor.js"

describe("RelayerMonitor (T-3.8)", () => {
  function mockProvider(balanceWei: bigint): BalanceProvider {
    return { getBalance: vi.fn().mockResolvedValue(balanceWei) }
  }

  it("reports healthy when balance above alert threshold", async () => {
    const monitor = new RelayerMonitor(
      mockProvider(50_000_000_000_000_000n), // 0.05 ETH
      "0xrelayer",
    )

    const health = await monitor.checkOnStartup()
    expect(health.status).toBe("healthy")
    expect(monitor.canSettle()).toBe(true)
  })

  it("reports low when balance below alert but above critical", async () => {
    const monitor = new RelayerMonitor(
      mockProvider(5_000_000_000_000_000n), // 0.005 ETH
      "0xrelayer",
    )

    const health = await monitor.checkOnStartup()
    expect(health.status).toBe("low")
    expect(monitor.canSettle()).toBe(true) // Still can settle
  })

  it("reports critical when balance below critical threshold", async () => {
    const monitor = new RelayerMonitor(
      mockProvider(500_000_000_000_000n), // 0.0005 ETH
      "0xrelayer",
    )

    const health = await monitor.checkOnStartup()
    expect(health.status).toBe("critical")
    expect(monitor.canSettle()).toBe(false) // Cannot settle
  })

  it("formats ETH balance correctly", async () => {
    const monitor = new RelayerMonitor(
      mockProvider(1_500_000_000_000_000_000n), // 1.5 ETH
      "0xrelayer",
    )

    const health = await monitor.getRelayerHealth()
    expect(health.balanceEth).toBe("1.500000")
  })
})

// --- T-3.9: Reconciliation ---

import { SettlementReconciler, type ReceiptChecker } from "../../../src/x402/reconciliation.js"
import { InMemorySettlementStore } from "../../../src/x402/settlement-store.js"

describe("SettlementReconciler (T-3.9)", () => {
  it("expires pending records older than 1 hour", async () => {
    const store = new InMemorySettlementStore()
    const checker: ReceiptChecker = { checkReceipt: vi.fn().mockResolvedValue("pending") }
    const reconciler = new SettlementReconciler(store, checker, { pendingMaxAgeMs: 0 }) // 0ms = expire immediately

    await store.claimPending("key-1", "q1")
    // Small delay to ensure updatedAt < cutoff
    await new Promise(r => setTimeout(r, 10))

    const result = await reconciler.reconcile()
    expect(result.expired).toBe(1)

    const record = await store.get("key-1")
    expect(record?.status).toBe("expired")
  })

  it("confirms submitted records with on-chain receipt", async () => {
    const store = new InMemorySettlementStore()
    const checker: ReceiptChecker = { checkReceipt: vi.fn().mockResolvedValue("confirmed") }
    const reconciler = new SettlementReconciler(store, checker, { submittedMaxAgeMs: 0 })

    await store.claimPending("key-2", "q2")
    await store.update("key-2", { status: "submitted", txHash: "0xabc" })
    await new Promise(r => setTimeout(r, 10))

    const result = await reconciler.reconcile()
    expect(result.confirmed).toBe(1)

    const record = await store.get("key-2")
    expect(record?.status).toBe("confirmed")
  })

  it("reverts submitted records with reverted receipt", async () => {
    const store = new InMemorySettlementStore()
    const checker: ReceiptChecker = { checkReceipt: vi.fn().mockResolvedValue("reverted") }
    const reconciler = new SettlementReconciler(store, checker, { submittedMaxAgeMs: 0 })

    await store.claimPending("key-3", "q3")
    await store.update("key-3", { status: "submitted", txHash: "0xdef" })
    await new Promise(r => setTimeout(r, 10))

    const result = await reconciler.reconcile()
    expect(result.reverted).toBe(1)

    const record = await store.get("key-3")
    expect(record?.status).toBe("reverted")
  })

  it("expires submitted without txHash", async () => {
    const store = new InMemorySettlementStore()
    const checker: ReceiptChecker = { checkReceipt: vi.fn() }
    const reconciler = new SettlementReconciler(store, checker, { submittedMaxAgeMs: 0 })

    await store.claimPending("key-4", "q4")
    await store.update("key-4", { status: "submitted" }) // No txHash
    await new Promise(r => setTimeout(r, 10))

    const result = await reconciler.reconcile()
    expect(result.expired).toBe(1)
    expect(checker.checkReceipt).not.toHaveBeenCalled()
  })
})
