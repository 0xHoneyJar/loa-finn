// tests/credits/consumption-atomic.test.ts — T1.2: TOCTOU race fix
//
// Bridge high-2 fix: 10 concurrent reserve requests against balance=5
// → exactly 5 succeed, 5 fail. No overspend.
//
// Tests both the atomic path (with atomicReserve) and validates that
// the legacy path still works for backward compatibility.

import { describe, it, expect, beforeEach } from "vitest"
import {
  reserveCredits,
  resetReservationCounter,
  type CreditStore,
  type CreditAccount,
  type ReservationReceipt,
} from "../../src/credits/consumption.js"

// ---------------------------------------------------------------------------
// Atomic Credit Store (simulates SQL conditional UPDATE)
// ---------------------------------------------------------------------------

class AtomicCreditStore implements CreditStore {
  accounts = new Map<string, CreditAccount>()
  reservations = new Map<string, ReservationReceipt>()

  async getAccount(wallet: string): Promise<CreditAccount | null> {
    return this.accounts.get(wallet) ?? null
  }

  async updateAccount(wallet: string, account: CreditAccount): Promise<void> {
    this.accounts.set(wallet, { ...account })
  }

  async getReservation(id: string): Promise<ReservationReceipt | null> {
    return this.reservations.get(id) ?? null
  }

  async setReservation(receipt: ReservationReceipt): Promise<void> {
    this.reservations.set(receipt.reservationId, { ...receipt })
  }

  async deleteReservation(id: string): Promise<void> {
    this.reservations.delete(id)
  }

  /**
   * Atomic reserve: simulates SQL conditional UPDATE.
   * Uses synchronous check-and-mutate (simulating DB row lock).
   * In production, this is a single SQL statement with WHERE unlocked >= amount.
   */
  async atomicReserve(wallet: string, amount: number): Promise<CreditAccount | null> {
    const account = this.accounts.get(wallet)
    if (!account) return null

    // Atomic: check and mutate in one step (simulates SQL WHERE clause)
    if (account.unlocked < amount) return null

    account.unlocked -= amount
    account.reserved += amount
    this.accounts.set(wallet, { ...account })
    return { ...account }
  }
}

// ---------------------------------------------------------------------------
// Non-Atomic Credit Store (legacy — for backward compat test)
// ---------------------------------------------------------------------------

class LegacyCreditStore implements CreditStore {
  accounts = new Map<string, CreditAccount>()
  reservations = new Map<string, ReservationReceipt>()

  async getAccount(wallet: string): Promise<CreditAccount | null> {
    return this.accounts.get(wallet) ?? null
  }

  async updateAccount(wallet: string, account: CreditAccount): Promise<void> {
    this.accounts.set(wallet, { ...account })
  }

  async getReservation(id: string): Promise<ReservationReceipt | null> {
    return this.reservations.get(id) ?? null
  }

  async setReservation(receipt: ReservationReceipt): Promise<void> {
    this.reservations.set(receipt.reservationId, { ...receipt })
  }

  async deleteReservation(id: string): Promise<void> {
    this.reservations.delete(id)
  }
  // No atomicReserve — falls back to legacy read-check-write
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Credit Consumption — Atomic Reserve (Bridge high-2)", () => {
  let store: AtomicCreditStore

  beforeEach(() => {
    store = new AtomicCreditStore()
    resetReservationCounter()
  })

  it("10 concurrent reserves against balance=5 → exactly 5 succeed", async () => {
    store.accounts.set("0xConcurrent", {
      wallet: "0xConcurrent",
      allocated: 0,
      unlocked: 5,
      reserved: 0,
      consumed: 0,
      expired: 0,
    })

    // Fire 10 concurrent reserve requests for 1 credit each
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        reserveCredits(store, "0xConcurrent", 1),
      ),
    )

    const reserved = results.filter(r => r.status === "reserved")
    const fallback = results.filter(r => r.status === "fallback_usdc")

    expect(reserved.length).toBe(5)
    expect(fallback.length).toBe(5)

    // Verify no overspend: unlocked should be 0, reserved should be 5
    const account = await store.getAccount("0xConcurrent")
    expect(account!.unlocked).toBe(0)
    expect(account!.reserved).toBe(5)
  })

  it("atomic reserve prevents negative balance", async () => {
    store.accounts.set("0xGuard", {
      wallet: "0xGuard",
      allocated: 0,
      unlocked: 3,
      reserved: 0,
      consumed: 0,
      expired: 0,
    })

    // Try to reserve 5 when only 3 available
    const result = await store.atomicReserve("0xGuard", 5)
    expect(result).toBeNull()

    // Balance unchanged
    const account = await store.getAccount("0xGuard")
    expect(account!.unlocked).toBe(3)
    expect(account!.reserved).toBe(0)
  })

  it("uses atomicReserve when available", async () => {
    store.accounts.set("0xAtomic", {
      wallet: "0xAtomic",
      allocated: 0,
      unlocked: 10,
      reserved: 0,
      consumed: 0,
      expired: 0,
    })

    const result = await reserveCredits(store, "0xAtomic", 3)
    expect(result.status).toBe("reserved")

    const account = await store.getAccount("0xAtomic")
    expect(account!.unlocked).toBe(7)
    expect(account!.reserved).toBe(3)
  })
})

describe("Credit Consumption — Legacy Store (backward compat)", () => {
  let store: LegacyCreditStore

  beforeEach(() => {
    store = new LegacyCreditStore()
    resetReservationCounter()
  })

  it("still works with legacy store (no atomicReserve)", async () => {
    store.accounts.set("0xLegacy", {
      wallet: "0xLegacy",
      allocated: 0,
      unlocked: 10,
      reserved: 0,
      consumed: 0,
      expired: 0,
    })

    const result = await reserveCredits(store, "0xLegacy", 3)
    expect(result.status).toBe("reserved")

    const account = await store.getAccount("0xLegacy")
    expect(account!.unlocked).toBe(7)
    expect(account!.reserved).toBe(3)
  })

  it("falls back gracefully when insufficient balance", async () => {
    store.accounts.set("0xShort", {
      wallet: "0xShort",
      allocated: 0,
      unlocked: 2,
      reserved: 0,
      consumed: 0,
      expired: 0,
    })

    const result = await reserveCredits(store, "0xShort", 5)
    expect(result.status).toBe("fallback_usdc")
  })
})

describe("Credit Consumption — Persistence Restore", () => {
  it("ledger restore methods work for startup recovery", async () => {
    const { CreditSubLedger } = await import("../../src/credits/rektdrop-ledger.js")
    const { CreditState, AllocationTier } = await import("../../src/credits/rektdrop-types.js")

    const ledger = new CreditSubLedger()

    // Simulate loading from Postgres
    ledger._restoreAccount({
      account_id: "0x1234567890abcdef1234567890abcdef12345678" as any,
      initial_allocation: 10_000n,
      balances: {
        [CreditState.ALLOCATED]: 5_000n,
        [CreditState.UNLOCKED]: 3_000n,
        [CreditState.RESERVED]: 1_000n,
        [CreditState.CONSUMED]: 1_000n,
        [CreditState.EXPIRED]: 0n,
      },
      tier: AllocationTier.OG,
      expires_at: Date.now() + 86_400_000,
      created_at: Date.now() - 86_400_000,
      updated_at: Date.now(),
    })

    ledger._restoreNonce("test-nonce-hash")
    ledger._restoreProcessedKey("test-idempotency-key")

    // Verify restored state
    const account = ledger.getAccount("0x1234567890abcdef1234567890abcdef12345678")
    expect(account).not.toBeNull()
    expect(account!.initial_allocation).toBe(10_000n)
    expect(account!.balances[CreditState.UNLOCKED]).toBe(3_000n)

    // Nonce is marked as used
    expect(ledger.isNonceUsed("test-nonce-hash")).toBe(true)
    expect(ledger.isNonceUsed("unknown-nonce")).toBe(false)

    // Conservation holds after restore
    expect(ledger.verifyConservation("0x1234567890abcdef1234567890abcdef12345678")).toBe(true)
  })
})
