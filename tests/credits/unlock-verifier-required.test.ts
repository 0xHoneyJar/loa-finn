// tests/credits/unlock-verifier-required.test.ts — T1.3: On-chain verifier is required
//
// Bridge high-3 fix: verifyOnChainTransfer must be explicitly provided.
// No default permissive fallback. TypeScript enforces at compile time,
// runtime check catches dynamic wiring failures.

import { describe, it, expect, vi } from "vitest"
import { CreditSubLedger } from "../../src/credits/rektdrop-ledger.js"
import { UnlockService } from "../../src/credits/unlock.js"
import { AllocationTier, _resetTxCounter } from "../../src/credits/rektdrop-types.js"

const TREASURY = "0xTREASURY0000000000000000000000000000000"

describe("UnlockService — Verifier Required (Bridge high-3)", () => {
  it("throws at construction when verifyOnChainTransfer is missing", () => {
    _resetTxCounter()
    const ledger = new CreditSubLedger()

    expect(() => {
      new UnlockService(
        // @ts-expect-error — intentionally omitting required field to test runtime guard
        { ledger },
        { treasuryAddress: TREASURY },
      )
    }).toThrow("requires verifyOnChainTransfer")
  })

  it("throws at construction when verifyOnChainTransfer is undefined", () => {
    _resetTxCounter()
    const ledger = new CreditSubLedger()

    expect(() => {
      new UnlockService(
        // @ts-expect-error — intentionally passing undefined to test runtime guard
        { ledger, verifyOnChainTransfer: undefined },
        { treasuryAddress: TREASURY },
      )
    }).toThrow("requires verifyOnChainTransfer")
  })

  it("constructs successfully when verifyOnChainTransfer is provided", () => {
    _resetTxCounter()
    const ledger = new CreditSubLedger()
    const verifier = vi.fn(async () => true)

    const service = new UnlockService(
      { ledger, verifyOnChainTransfer: verifier },
      { treasuryAddress: TREASURY },
    )

    expect(service).toBeDefined()
  })

  it("does NOT default to accepting all transfers", async () => {
    _resetTxCounter()
    const ledger = new CreditSubLedger()
    const wallet = "0x1234567890abcdef1234567890abcdef12345678"
    ledger.createAccount(wallet, AllocationTier.OG, 10_000n)

    // Verifier that always rejects
    const rejectVerifier = vi.fn(async () => false)

    const service = new UnlockService(
      { ledger, verifyOnChainTransfer: rejectVerifier },
      { treasuryAddress: TREASURY },
    )

    const now = Math.floor(Date.now() / 1000)
    await expect(
      service.unlock({
        wallet,
        amount: 1_000n,
        authorization: {
          from: wallet,
          to: TREASURY,
          value: "1000000",
          valid_after: now - 60,
          valid_before: now + 300,
          nonce: "test-nonce-reject",
          v: 27,
          r: "0x" + "ab".repeat(32),
          s: "0x" + "cd".repeat(32),
        },
        idempotency_key: "unlock-reject-test",
      }),
    ).rejects.toThrow("USDC transfer could not be verified")

    expect(rejectVerifier).toHaveBeenCalledOnce()
  })
})
