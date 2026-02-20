// tests/credits/unlock.test.ts — USDC Unlock Flow Tests (Sprint 21 Task 21.3)
//
// Happy path, nonce replay protection, already-unlocked, insufficient balance,
// authorization validation, on-chain verification failure, conservation invariant.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { CreditSubLedger } from "../../src/credits/rektdrop-ledger.js"
import { UnlockService } from "../../src/credits/unlock.js"
import {
  type EIP3009UnlockAuth,
  type UnlockRequest,
  CreditState,
  AllocationTier,
  RektdropError,
  _resetTxCounter,
} from "../../src/credits/rektdrop-types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WALLET = "0x1234567890abcdef1234567890abcdef12345678"
const TREASURY = "0xTREASURY0000000000000000000000000000000"

function validAuth(overrides?: Partial<EIP3009UnlockAuth>): EIP3009UnlockAuth {
  const now = Math.floor(Date.now() / 1000)
  return {
    from: WALLET,
    to: TREASURY,
    value: "5000000", // 5 USDC in base units (enough for 5000 credits at 1000 per credit)
    valid_after: now - 60,
    valid_before: now + 300,
    nonce: `nonce_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    v: 27,
    r: "0x" + "ab".repeat(32),
    s: "0x" + "cd".repeat(32),
    ...overrides,
  }
}

function validRequest(overrides?: Partial<UnlockRequest>): UnlockRequest {
  return {
    wallet: WALLET,
    amount: 5_000n,
    authorization: validAuth(),
    idempotency_key: `unlock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  }
}

interface TestContext {
  ledger: CreditSubLedger
  service: UnlockService
  verifyOnChain: ReturnType<typeof vi.fn>
  onUnlock: ReturnType<typeof vi.fn>
}

function createTestContext(opts?: { verifyResult?: boolean }): TestContext {
  _resetTxCounter()
  const ledger = new CreditSubLedger()
  const verifyOnChain = vi.fn(async () => opts?.verifyResult ?? true)
  const onUnlock = vi.fn()

  const service = new UnlockService(
    { ledger, verifyOnChainTransfer: verifyOnChain, onUnlock },
    { treasuryAddress: TREASURY, usdcPerCredit: 1_000n },
  )

  // Pre-create account with 10_000 allocated credits
  ledger.createAccount(WALLET, AllocationTier.OG, 10_000n)

  return { ledger, service, verifyOnChain, onUnlock }
}

// ---------------------------------------------------------------------------
// Happy Path
// ---------------------------------------------------------------------------

describe("UnlockService — Happy Path", () => {
  let ctx: TestContext

  beforeEach(() => {
    ctx = createTestContext()
  })

  it("unlocks credits with valid authorization", async () => {
    const request = validRequest()
    const result = await ctx.service.unlock(request)

    expect(result.status).toBe("unlocked")
    expect(result.unlocked_amount).toBe(5_000n)
    expect(result.remaining_allocated).toBe(5_000n)
    expect(result.remaining_unlocked).toBe(5_000n)
    expect(result.tx_id).toBeDefined()
    expect(result.account_id).toBe(WALLET.toLowerCase())
  })

  it("verifies on-chain transfer before unlocking", async () => {
    const request = validRequest()
    await ctx.service.unlock(request)

    expect(ctx.verifyOnChain).toHaveBeenCalledOnce()
    expect(ctx.verifyOnChain).toHaveBeenCalledWith(request.authorization)
  })

  it("calls onUnlock callback after successful unlock", async () => {
    const request = validRequest()
    const result = await ctx.service.unlock(request)

    expect(ctx.onUnlock).toHaveBeenCalledOnce()
    expect(ctx.onUnlock).toHaveBeenCalledWith(WALLET, 5_000n, result.tx_id)
  })

  it("transitions ALLOCATED → UNLOCKED in the ledger", async () => {
    const request = validRequest()
    await ctx.service.unlock(request)

    const account = ctx.ledger.getAccount(WALLET)!
    expect(account.balances[CreditState.ALLOCATED]).toBe(5_000n)
    expect(account.balances[CreditState.UNLOCKED]).toBe(5_000n)
  })

  it("preserves conservation invariant after unlock", async () => {
    const request = validRequest()
    await ctx.service.unlock(request)

    expect(ctx.ledger.verifyConservation(WALLET)).toBe(true)
  })

  it("allows partial unlock — multiple unlocks for same wallet", async () => {
    const auth1 = validAuth({ nonce: "nonce-partial-1" })
    const auth2 = validAuth({ nonce: "nonce-partial-2" })

    await ctx.service.unlock({
      wallet: WALLET,
      amount: 3_000n,
      authorization: { ...auth1, value: "3000000" },
      idempotency_key: "unlock-partial-1",
    })

    await ctx.service.unlock({
      wallet: WALLET,
      amount: 2_000n,
      authorization: { ...auth2, value: "2000000" },
      idempotency_key: "unlock-partial-2",
    })

    const account = ctx.ledger.getAccount(WALLET)!
    expect(account.balances[CreditState.ALLOCATED]).toBe(5_000n)
    expect(account.balances[CreditState.UNLOCKED]).toBe(5_000n)
    expect(ctx.ledger.verifyConservation(WALLET)).toBe(true)
  })

  it("unlocks all remaining allocated credits", async () => {
    const auth = validAuth({ nonce: "nonce-all", value: "10000000" })
    await ctx.service.unlock({
      wallet: WALLET,
      amount: 10_000n,
      authorization: auth,
      idempotency_key: "unlock-all",
    })

    const account = ctx.ledger.getAccount(WALLET)!
    expect(account.balances[CreditState.ALLOCATED]).toBe(0n)
    expect(account.balances[CreditState.UNLOCKED]).toBe(10_000n)
  })
})

// ---------------------------------------------------------------------------
// Nonce Replay Protection
// ---------------------------------------------------------------------------

describe("UnlockService — Nonce Replay Protection", () => {
  let ctx: TestContext

  beforeEach(() => {
    ctx = createTestContext()
  })

  it("rejects replay with same nonce", async () => {
    const auth = validAuth({ nonce: "replay-nonce-1" })

    await ctx.service.unlock({
      wallet: WALLET,
      amount: 2_000n,
      authorization: { ...auth, value: "2000000" },
      idempotency_key: "unlock-replay-1",
    })

    await expect(
      ctx.service.unlock({
        wallet: WALLET,
        amount: 2_000n,
        authorization: { ...auth, value: "2000000" },
        idempotency_key: "unlock-replay-2", // different idempotency key
      }),
    ).rejects.toThrow(RektdropError)

    try {
      await ctx.service.unlock({
        wallet: WALLET,
        amount: 2_000n,
        authorization: { ...auth, value: "2000000" },
        idempotency_key: "unlock-replay-3",
      })
    } catch (e: unknown) {
      const err = e as RektdropError
      expect(err.code).toBe("NONCE_REPLAY")
      expect(err.httpStatus).toBe(409)
    }

    // Balance unchanged after replay attempt
    const account = ctx.ledger.getAccount(WALLET)!
    expect(account.balances[CreditState.ALLOCATED]).toBe(8_000n)
    expect(account.balances[CreditState.UNLOCKED]).toBe(2_000n)
  })

  it("allows different nonces for same wallet", async () => {
    const auth1 = validAuth({ nonce: "unique-nonce-1", value: "1000000" })
    const auth2 = validAuth({ nonce: "unique-nonce-2", value: "1000000" })

    await ctx.service.unlock({
      wallet: WALLET,
      amount: 1_000n,
      authorization: auth1,
      idempotency_key: "unlock-1",
    })

    await ctx.service.unlock({
      wallet: WALLET,
      amount: 1_000n,
      authorization: auth2,
      idempotency_key: "unlock-2",
    })

    const account = ctx.ledger.getAccount(WALLET)!
    expect(account.balances[CreditState.UNLOCKED]).toBe(2_000n)
  })
})

// ---------------------------------------------------------------------------
// Already Unlocked / Insufficient
// ---------------------------------------------------------------------------

describe("UnlockService — Already Unlocked", () => {
  let ctx: TestContext

  beforeEach(() => {
    ctx = createTestContext()
  })

  it("rejects when all credits already unlocked", async () => {
    // Unlock all 10000
    const auth1 = validAuth({ nonce: "nonce-full", value: "10000000" })
    await ctx.service.unlock({
      wallet: WALLET,
      amount: 10_000n,
      authorization: auth1,
      idempotency_key: "full-unlock",
    })

    // Try to unlock more
    const auth2 = validAuth({ nonce: "nonce-more" })
    await expect(
      ctx.service.unlock({
        wallet: WALLET,
        amount: 1_000n,
        authorization: auth2,
        idempotency_key: "extra-unlock",
      }),
    ).rejects.toThrow(RektdropError)

    try {
      const auth3 = validAuth({ nonce: "nonce-more-2" })
      await ctx.service.unlock({
        wallet: WALLET,
        amount: 1_000n,
        authorization: auth3,
        idempotency_key: "extra-unlock-2",
      })
    } catch (e: unknown) {
      const err = e as RektdropError
      expect(err.code).toBe("ALREADY_UNLOCKED")
    }
  })

  it("rejects when requested amount exceeds remaining allocated", async () => {
    // Unlock 8000 of 10000
    const auth1 = validAuth({ nonce: "nonce-8k", value: "8000000" })
    await ctx.service.unlock({
      wallet: WALLET,
      amount: 8_000n,
      authorization: auth1,
      idempotency_key: "unlock-8k",
    })

    // Try to unlock 3000 (only 2000 allocated remain)
    const auth2 = validAuth({ nonce: "nonce-3k", value: "3000000" })
    await expect(
      ctx.service.unlock({
        wallet: WALLET,
        amount: 3_000n,
        authorization: auth2,
        idempotency_key: "unlock-3k",
      }),
    ).rejects.toThrow(RektdropError)

    try {
      const auth3 = validAuth({ nonce: "nonce-3k-2", value: "3000000" })
      await ctx.service.unlock({
        wallet: WALLET,
        amount: 3_000n,
        authorization: auth3,
        idempotency_key: "unlock-3k-2",
      })
    } catch (e: unknown) {
      const err = e as RektdropError
      expect(err.code).toBe("INSUFFICIENT_ALLOCATED")
    }
  })

  it("rejects unlock for nonexistent wallet", async () => {
    const unknownWallet = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    const auth = validAuth({ from: unknownWallet, nonce: "nonce-unknown" })

    await expect(
      ctx.service.unlock({
        wallet: unknownWallet,
        amount: 1_000n,
        authorization: auth,
        idempotency_key: "unlock-unknown",
      }),
    ).rejects.toThrow(RektdropError)

    try {
      const auth2 = validAuth({ from: unknownWallet, nonce: "nonce-unknown-2" })
      await ctx.service.unlock({
        wallet: unknownWallet,
        amount: 1_000n,
        authorization: auth2,
        idempotency_key: "unlock-unknown-2",
      })
    } catch (e: unknown) {
      const err = e as RektdropError
      expect(err.code).toBe("INVALID_WALLET")
    }
  })

  it("rejects zero amount unlock", async () => {
    const auth = validAuth({ nonce: "nonce-zero" })
    await expect(
      ctx.service.unlock({
        wallet: WALLET,
        amount: 0n,
        authorization: auth,
        idempotency_key: "unlock-zero",
      }),
    ).rejects.toThrow(RektdropError)
  })
})

// ---------------------------------------------------------------------------
// Authorization Validation
// ---------------------------------------------------------------------------

describe("UnlockService — Authorization Validation", () => {
  let ctx: TestContext

  beforeEach(() => {
    ctx = createTestContext()
  })

  it("rejects wrong treasury address", async () => {
    const auth = validAuth({
      to: "0xWRONG000000000000000000000000000000000000",
      nonce: "nonce-wrong-treasury",
    })

    await expect(
      ctx.service.unlock({
        wallet: WALLET,
        amount: 1_000n,
        authorization: auth,
        idempotency_key: "unlock-wrong-treasury",
      }),
    ).rejects.toThrow(RektdropError)

    try {
      const auth2 = validAuth({
        to: "0xWRONG000000000000000000000000000000000000",
        nonce: "nonce-wrong-treasury-2",
      })
      await ctx.service.unlock({
        wallet: WALLET,
        amount: 1_000n,
        authorization: auth2,
        idempotency_key: "unlock-wrong-treasury-2",
      })
    } catch (e: unknown) {
      const err = e as RektdropError
      expect(err.code).toBe("UNLOCK_VERIFICATION_FAILED")
    }
  })

  it("rejects insufficient USDC payment", async () => {
    const auth = validAuth({
      value: "100", // Way too little
      nonce: "nonce-insufficient-usdc",
    })

    await expect(
      ctx.service.unlock({
        wallet: WALLET,
        amount: 5_000n,
        authorization: auth,
        idempotency_key: "unlock-insufficient",
      }),
    ).rejects.toThrow(RektdropError)

    try {
      const auth2 = validAuth({
        value: "100",
        nonce: "nonce-insufficient-usdc-2",
      })
      await ctx.service.unlock({
        wallet: WALLET,
        amount: 5_000n,
        authorization: auth2,
        idempotency_key: "unlock-insufficient-2",
      })
    } catch (e: unknown) {
      const err = e as RektdropError
      expect(err.code).toBe("INVALID_AMOUNT")
    }
  })

  it("rejects expired authorization", async () => {
    const pastTime = Math.floor(Date.now() / 1000) - 600
    const auth = validAuth({
      valid_before: pastTime,
      nonce: "nonce-expired",
    })

    await expect(
      ctx.service.unlock({
        wallet: WALLET,
        amount: 1_000n,
        authorization: auth,
        idempotency_key: "unlock-expired",
      }),
    ).rejects.toThrow(RektdropError)

    try {
      const auth2 = validAuth({
        valid_before: pastTime,
        nonce: "nonce-expired-2",
      })
      await ctx.service.unlock({
        wallet: WALLET,
        amount: 1_000n,
        authorization: auth2,
        idempotency_key: "unlock-expired-2",
      })
    } catch (e: unknown) {
      const err = e as RektdropError
      expect(err.code).toBe("AUTHORIZATION_EXPIRED")
    }
  })

  it("rejects authorization not yet valid", async () => {
    const futureTime = Math.floor(Date.now() / 1000) + 600
    const auth = validAuth({
      valid_after: futureTime,
      nonce: "nonce-not-yet-valid",
    })

    await expect(
      ctx.service.unlock({
        wallet: WALLET,
        amount: 1_000n,
        authorization: auth,
        idempotency_key: "unlock-not-yet-valid",
      }),
    ).rejects.toThrow(RektdropError)

    try {
      const auth2 = validAuth({
        valid_after: futureTime,
        nonce: "nonce-not-yet-valid-2",
      })
      await ctx.service.unlock({
        wallet: WALLET,
        amount: 1_000n,
        authorization: auth2,
        idempotency_key: "unlock-not-yet-valid-2",
      })
    } catch (e: unknown) {
      const err = e as RektdropError
      expect(err.code).toBe("AUTHORIZATION_EXPIRED")
    }
  })

  it("rejects empty nonce", async () => {
    const auth = validAuth({ nonce: "" })

    await expect(
      ctx.service.unlock({
        wallet: WALLET,
        amount: 1_000n,
        authorization: auth,
        idempotency_key: "unlock-empty-nonce",
      }),
    ).rejects.toThrow(RektdropError)
  })
})

// ---------------------------------------------------------------------------
// On-Chain Verification Failure
// ---------------------------------------------------------------------------

describe("UnlockService — On-Chain Verification Failure", () => {
  it("rejects when on-chain verification returns false", async () => {
    const ctx = createTestContext({ verifyResult: false })

    const request = validRequest()
    await expect(ctx.service.unlock(request)).rejects.toThrow(RektdropError)

    try {
      const request2 = validRequest()
      await ctx.service.unlock(request2)
    } catch (e: unknown) {
      const err = e as RektdropError
      expect(err.code).toBe("UNLOCK_VERIFICATION_FAILED")
    }

    // Balance unchanged
    const account = ctx.ledger.getAccount(WALLET)!
    expect(account.balances[CreditState.ALLOCATED]).toBe(10_000n)
    expect(account.balances[CreditState.UNLOCKED]).toBe(0n)
  })

  it("rejects when on-chain verification throws", async () => {
    _resetTxCounter()
    const ledger = new CreditSubLedger()
    const verifyOnChain = vi.fn(async () => {
      throw new Error("RPC timeout")
    })

    const service = new UnlockService(
      { ledger, verifyOnChainTransfer: verifyOnChain },
      { treasuryAddress: TREASURY },
    )

    ledger.createAccount(WALLET, AllocationTier.OG, 10_000n)

    const request = validRequest()
    await expect(service.unlock(request)).rejects.toThrow(RektdropError)

    try {
      const request2 = validRequest()
      await service.unlock(request2)
    } catch (e: unknown) {
      const err = e as RektdropError
      expect(err.code).toBe("UNLOCK_VERIFICATION_FAILED")
      expect(err.message).toContain("RPC timeout")
    }
  })
})

// ---------------------------------------------------------------------------
// canUnlock Preview
// ---------------------------------------------------------------------------

describe("UnlockService — canUnlock", () => {
  let ctx: TestContext

  beforeEach(() => {
    ctx = createTestContext()
  })

  it("returns eligible for valid unlock", () => {
    const result = ctx.service.canUnlock(WALLET, 5_000n)
    expect(result.eligible).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it("returns ineligible for nonexistent wallet", () => {
    const unknownWallet = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    const result = ctx.service.canUnlock(unknownWallet, 1_000n)
    expect(result.eligible).toBe(false)
    expect(result.reason).toContain("No credit account")
  })

  it("returns ineligible when exceeds allocated balance", () => {
    const result = ctx.service.canUnlock(WALLET, 20_000n)
    expect(result.eligible).toBe(false)
    expect(result.reason).toContain("exceeds")
  })

  it("returns ineligible when no allocated credits remain", async () => {
    // Unlock everything
    const auth = validAuth({ nonce: "nonce-all-for-preview", value: "10000000" })
    await ctx.service.unlock({
      wallet: WALLET,
      amount: 10_000n,
      authorization: auth,
      idempotency_key: "unlock-all-preview",
    })

    const result = ctx.service.canUnlock(WALLET, 1_000n)
    expect(result.eligible).toBe(false)
    expect(result.reason).toContain("No allocated credits")
  })
})

// ---------------------------------------------------------------------------
// computeRequiredUsdc
// ---------------------------------------------------------------------------

describe("UnlockService — computeRequiredUsdc", () => {
  it("computes correct USDC for credit amount", () => {
    const ctx = createTestContext()
    // 1000 base units per credit
    expect(ctx.service.computeRequiredUsdc(1_000n)).toBe(1_000_000n)
    expect(ctx.service.computeRequiredUsdc(5_000n)).toBe(5_000_000n)
    expect(ctx.service.computeRequiredUsdc(1n)).toBe(1_000n)
  })
})

// ---------------------------------------------------------------------------
// Conservation After Error
// ---------------------------------------------------------------------------

describe("UnlockService — Conservation After Error", () => {
  it("conservation holds even after failed unlock attempts", async () => {
    const ctx = createTestContext({ verifyResult: false })

    // This will fail on-chain verification
    try {
      await ctx.service.unlock(validRequest())
    } catch {
      // expected
    }

    // Conservation still holds
    expect(ctx.ledger.verifyConservation(WALLET)).toBe(true)

    // Balances unchanged
    const account = ctx.ledger.getAccount(WALLET)!
    expect(account.balances[CreditState.ALLOCATED]).toBe(10_000n)
    expect(account.balances[CreditState.UNLOCKED]).toBe(0n)
  })
})
