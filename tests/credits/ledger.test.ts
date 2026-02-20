// tests/credits/ledger.test.ts — Credit Sub-Ledger Tests (Sprint 21 Task 21.1)
//
// State machine transitions, conservation invariant, double-entry,
// idempotency, TTL expiry, and edge cases.

import { describe, it, expect, beforeEach } from "vitest"
import { CreditSubLedger } from "../../src/credits/rektdrop-ledger.js"
import {
  CreditState,
  CreditLedgerError,
  CreditStateError,
  AllocationTier,
  TIER_AMOUNTS,
  _resetTxCounter,
} from "../../src/credits/rektdrop-types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WALLET_A = "0x1234567890abcdef1234567890abcdef12345678"
const WALLET_B = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"

function freshLedger(): CreditSubLedger {
  _resetTxCounter()
  return new CreditSubLedger()
}

// ---------------------------------------------------------------------------
// Account Creation
// ---------------------------------------------------------------------------

describe("CreditSubLedger — Account Creation", () => {
  let ledger: CreditSubLedger

  beforeEach(() => {
    ledger = freshLedger()
  })

  it("creates an account with all credits in ALLOCATED state", () => {
    const account = ledger.createAccount(WALLET_A, AllocationTier.OG)
    expect(account.account_id).toBe(WALLET_A.toLowerCase())
    expect(account.initial_allocation).toBe(TIER_AMOUNTS.OG)
    expect(account.balances[CreditState.ALLOCATED]).toBe(TIER_AMOUNTS.OG)
    expect(account.balances[CreditState.UNLOCKED]).toBe(0n)
    expect(account.balances[CreditState.RESERVED]).toBe(0n)
    expect(account.balances[CreditState.CONSUMED]).toBe(0n)
    expect(account.balances[CreditState.EXPIRED]).toBe(0n)
    expect(account.tier).toBe(AllocationTier.OG)
  })

  it("uses tier default amount when no custom amount provided", () => {
    const og = ledger.createAccount(WALLET_A, AllocationTier.OG)
    expect(og.initial_allocation).toBe(10_000n)

    const community = ledger.createAccount(WALLET_B, AllocationTier.COMMUNITY)
    expect(community.initial_allocation).toBe(1_000n)
  })

  it("allows custom allocation amounts", () => {
    const account = ledger.createAccount(WALLET_A, AllocationTier.PARTNER, 50_000n)
    expect(account.initial_allocation).toBe(50_000n)
    expect(account.balances[CreditState.ALLOCATED]).toBe(50_000n)
  })

  it("rejects zero or negative allocation amounts", () => {
    expect(() => ledger.createAccount(WALLET_A, AllocationTier.OG, 0n)).toThrow(CreditLedgerError)
    expect(() => ledger.createAccount(WALLET_A, AllocationTier.OG, -1n)).toThrow(CreditLedgerError)
  })

  it("rejects invalid wallet addresses", () => {
    expect(() => ledger.createAccount("not-an-address", AllocationTier.OG)).toThrow()
    expect(() => ledger.createAccount("0x123", AllocationTier.OG)).toThrow()
  })

  it("is idempotent — re-creating same wallet returns existing account", () => {
    const first = ledger.createAccount(WALLET_A, AllocationTier.OG)
    const second = ledger.createAccount(WALLET_A, AllocationTier.OG)
    expect(second).toBe(first)
    expect(ledger.accountCount).toBe(1)
  })

  it("records an allocation transaction in the journal", () => {
    ledger.createAccount(WALLET_A, AllocationTier.OG)
    const txns = ledger.getTransactions(WALLET_A)
    expect(txns.length).toBe(1)
    expect(txns[0].event_type).toBe("rektdrop_allocate")
    expect(txns[0].amount).toBe(TIER_AMOUNTS.OG)
  })

  it("sets TTL correctly", () => {
    const before = Date.now()
    const account = ledger.createAccount(WALLET_A, AllocationTier.OG, undefined, 1000)
    const after = Date.now()
    expect(account.expires_at).toBeGreaterThanOrEqual(before + 1000)
    expect(account.expires_at).toBeLessThanOrEqual(after + 1000)
  })
})

// ---------------------------------------------------------------------------
// Conservation Invariant
// ---------------------------------------------------------------------------

describe("CreditSubLedger — Conservation Invariant", () => {
  let ledger: CreditSubLedger

  beforeEach(() => {
    ledger = freshLedger()
    ledger.createAccount(WALLET_A, AllocationTier.OG)
  })

  it("holds after account creation", () => {
    expect(ledger.verifyConservation(WALLET_A)).toBe(true)
  })

  it("holds after unlock: ALLOCATED → UNLOCKED", () => {
    ledger.unlock(WALLET_A, 3_000n, "corr-1", "unlock-1")
    expect(ledger.verifyConservation(WALLET_A)).toBe(true)

    const account = ledger.getAccount(WALLET_A)!
    expect(account.balances[CreditState.ALLOCATED]).toBe(7_000n)
    expect(account.balances[CreditState.UNLOCKED]).toBe(3_000n)
  })

  it("holds after reserve: UNLOCKED → RESERVED", () => {
    ledger.unlock(WALLET_A, 5_000n, "corr-1", "unlock-1")
    ledger.reserve(WALLET_A, 2_000n, "corr-2", "reserve-1")
    expect(ledger.verifyConservation(WALLET_A)).toBe(true)
  })

  it("holds after consume: RESERVED → CONSUMED", () => {
    ledger.unlock(WALLET_A, 5_000n, "corr-1", "unlock-1")
    ledger.reserve(WALLET_A, 2_000n, "corr-2", "reserve-1")
    ledger.consume(WALLET_A, 2_000n, "corr-3", "consume-1")
    expect(ledger.verifyConservation(WALLET_A)).toBe(true)
  })

  it("holds after release: RESERVED → UNLOCKED", () => {
    ledger.unlock(WALLET_A, 5_000n, "corr-1", "unlock-1")
    ledger.reserve(WALLET_A, 3_000n, "corr-2", "reserve-1")
    ledger.release(WALLET_A, 3_000n, "corr-3", "release-1")
    expect(ledger.verifyConservation(WALLET_A)).toBe(true)

    const account = ledger.getAccount(WALLET_A)!
    expect(account.balances[CreditState.UNLOCKED]).toBe(5_000n)
    expect(account.balances[CreditState.RESERVED]).toBe(0n)
  })

  it("holds after expire: ALLOCATED → EXPIRED", () => {
    ledger.expire(WALLET_A, CreditState.ALLOCATED, 10_000n, "corr-1", "expire-1")
    expect(ledger.verifyConservation(WALLET_A)).toBe(true)

    const account = ledger.getAccount(WALLET_A)!
    expect(account.balances[CreditState.ALLOCATED]).toBe(0n)
    expect(account.balances[CreditState.EXPIRED]).toBe(10_000n)
  })

  it("holds after full lifecycle: allocate → unlock → reserve → consume", () => {
    // Unlock 6000 of 10000
    ledger.unlock(WALLET_A, 6_000n, "corr-1", "unlock-1")
    // Reserve 4000 of the 6000 unlocked
    ledger.reserve(WALLET_A, 4_000n, "corr-2", "reserve-1")
    // Consume 3000 of the 4000 reserved
    ledger.consume(WALLET_A, 3_000n, "corr-3", "consume-1")
    // Release remaining 1000 reserved back to unlocked
    ledger.release(WALLET_A, 1_000n, "corr-4", "release-1")
    // Expire remaining 4000 allocated
    ledger.expire(WALLET_A, CreditState.ALLOCATED, 4_000n, "corr-5", "expire-1")

    expect(ledger.verifyConservation(WALLET_A)).toBe(true)

    const account = ledger.getAccount(WALLET_A)!
    expect(account.balances[CreditState.ALLOCATED]).toBe(0n)
    expect(account.balances[CreditState.UNLOCKED]).toBe(3_000n) // 6000 - 4000 + 1000
    expect(account.balances[CreditState.RESERVED]).toBe(0n)
    expect(account.balances[CreditState.CONSUMED]).toBe(3_000n)
    expect(account.balances[CreditState.EXPIRED]).toBe(4_000n)

    // Sum = 0 + 3000 + 0 + 3000 + 4000 = 10000 = initial_allocation
    const total = Object.values(account.balances).reduce((a, b) => a + b, 0n)
    expect(total).toBe(account.initial_allocation)
  })

  it("verifyAllConservation checks all accounts", () => {
    ledger.createAccount(WALLET_B, AllocationTier.COMMUNITY)
    ledger.unlock(WALLET_A, 2_000n, "corr-1", "unlock-1")
    ledger.unlock(WALLET_B, 500n, "corr-2", "unlock-2")

    const result = ledger.verifyAllConservation()
    expect(result.valid).toBe(true)
    expect(result.violations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// State Machine Transitions
// ---------------------------------------------------------------------------

describe("CreditSubLedger — State Machine", () => {
  let ledger: CreditSubLedger

  beforeEach(() => {
    ledger = freshLedger()
    ledger.createAccount(WALLET_A, AllocationTier.OG)
  })

  it("ALLOCATED → UNLOCKED via unlock()", () => {
    const tx = ledger.unlock(WALLET_A, 1_000n, "corr-1", "key-1")
    expect(tx.event_type).toBe("usdc_unlock")
    expect(tx.debit_state).toBe(CreditState.ALLOCATED)
    expect(tx.credit_state).toBe(CreditState.UNLOCKED)
  })

  it("UNLOCKED → RESERVED via reserve()", () => {
    ledger.unlock(WALLET_A, 5_000n, "corr-1", "key-1")
    const tx = ledger.reserve(WALLET_A, 2_000n, "corr-2", "key-2")
    expect(tx.debit_state).toBe(CreditState.UNLOCKED)
    expect(tx.credit_state).toBe(CreditState.RESERVED)
  })

  it("RESERVED → CONSUMED via consume()", () => {
    ledger.unlock(WALLET_A, 5_000n, "corr-1", "key-1")
    ledger.reserve(WALLET_A, 2_000n, "corr-2", "key-2")
    const tx = ledger.consume(WALLET_A, 2_000n, "corr-3", "key-3")
    expect(tx.debit_state).toBe(CreditState.RESERVED)
    expect(tx.credit_state).toBe(CreditState.CONSUMED)
  })

  it("RESERVED → UNLOCKED via release()", () => {
    ledger.unlock(WALLET_A, 5_000n, "corr-1", "key-1")
    ledger.reserve(WALLET_A, 2_000n, "corr-2", "key-2")
    const tx = ledger.release(WALLET_A, 2_000n, "corr-3", "key-3")
    expect(tx.debit_state).toBe(CreditState.RESERVED)
    expect(tx.credit_state).toBe(CreditState.UNLOCKED)
  })

  it("ALLOCATED → EXPIRED via expire()", () => {
    const tx = ledger.expire(WALLET_A, CreditState.ALLOCATED, 5_000n, "corr-1", "key-1")
    expect(tx.debit_state).toBe(CreditState.ALLOCATED)
    expect(tx.credit_state).toBe(CreditState.EXPIRED)
  })

  it("UNLOCKED → EXPIRED via expire()", () => {
    ledger.unlock(WALLET_A, 5_000n, "corr-1", "key-1")
    const tx = ledger.expire(WALLET_A, CreditState.UNLOCKED, 3_000n, "corr-2", "key-2")
    expect(tx.debit_state).toBe(CreditState.UNLOCKED)
    expect(tx.credit_state).toBe(CreditState.EXPIRED)
  })

  // --- Invalid transitions ---

  it("rejects ALLOCATED → RESERVED (must unlock first)", () => {
    expect(() =>
      ledger.transfer(
        WALLET_A, CreditState.ALLOCATED, CreditState.RESERVED,
        1_000n, "credit_reserve", "corr-1", "key-1",
      ),
    ).toThrow(CreditStateError)
  })

  it("rejects ALLOCATED → CONSUMED", () => {
    expect(() =>
      ledger.transfer(
        WALLET_A, CreditState.ALLOCATED, CreditState.CONSUMED,
        1_000n, "credit_consume", "corr-1", "key-1",
      ),
    ).toThrow(CreditStateError)
  })

  it("rejects CONSUMED → anything (terminal state)", () => {
    ledger.unlock(WALLET_A, 5_000n, "corr-1", "key-1")
    ledger.reserve(WALLET_A, 2_000n, "corr-2", "key-2")
    ledger.consume(WALLET_A, 2_000n, "corr-3", "key-3")

    expect(() =>
      ledger.transfer(
        WALLET_A, CreditState.CONSUMED, CreditState.UNLOCKED,
        1_000n, "credit_release", "corr-4", "key-4",
      ),
    ).toThrow(CreditStateError)
  })

  it("rejects EXPIRED → anything (terminal state)", () => {
    ledger.expire(WALLET_A, CreditState.ALLOCATED, 5_000n, "corr-1", "key-1")

    expect(() =>
      ledger.transfer(
        WALLET_A, CreditState.EXPIRED, CreditState.ALLOCATED,
        1_000n, "rektdrop_allocate", "corr-2", "key-2",
      ),
    ).toThrow(CreditStateError)
  })

  it("rejects expire from RESERVED state", () => {
    ledger.unlock(WALLET_A, 5_000n, "corr-1", "key-1")
    ledger.reserve(WALLET_A, 2_000n, "corr-2", "key-2")

    expect(() =>
      ledger.expire(WALLET_A, CreditState.RESERVED, 2_000n, "corr-3", "key-3"),
    ).toThrow(CreditStateError)
  })

  it("rejects expire from CONSUMED state", () => {
    ledger.unlock(WALLET_A, 5_000n, "corr-1", "key-1")
    ledger.reserve(WALLET_A, 2_000n, "corr-2", "key-2")
    ledger.consume(WALLET_A, 2_000n, "corr-3", "key-3")

    expect(() =>
      ledger.expire(WALLET_A, CreditState.CONSUMED, 2_000n, "corr-4", "key-4"),
    ).toThrow(CreditStateError)
  })
})

// ---------------------------------------------------------------------------
// Insufficient Balance
// ---------------------------------------------------------------------------

describe("CreditSubLedger — Insufficient Balance", () => {
  let ledger: CreditSubLedger

  beforeEach(() => {
    ledger = freshLedger()
    ledger.createAccount(WALLET_A, AllocationTier.COMMUNITY) // 1000 credits
  })

  it("rejects unlock exceeding allocated balance", () => {
    expect(() =>
      ledger.unlock(WALLET_A, 1_001n, "corr-1", "key-1"),
    ).toThrow(CreditLedgerError)
  })

  it("rejects reserve exceeding unlocked balance", () => {
    ledger.unlock(WALLET_A, 500n, "corr-1", "key-1")
    expect(() =>
      ledger.reserve(WALLET_A, 501n, "corr-2", "key-2"),
    ).toThrow(CreditLedgerError)
  })

  it("rejects consume exceeding reserved balance", () => {
    ledger.unlock(WALLET_A, 500n, "corr-1", "key-1")
    ledger.reserve(WALLET_A, 300n, "corr-2", "key-2")
    expect(() =>
      ledger.consume(WALLET_A, 301n, "corr-3", "key-3"),
    ).toThrow(CreditLedgerError)
  })

  it("rejects zero amount transfers", () => {
    expect(() =>
      ledger.unlock(WALLET_A, 0n, "corr-1", "key-1"),
    ).toThrow(CreditLedgerError)
  })

  it("rejects negative amount transfers", () => {
    expect(() =>
      ledger.unlock(WALLET_A, -1n, "corr-1", "key-1"),
    ).toThrow(CreditLedgerError)
  })
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("CreditSubLedger — Idempotency", () => {
  let ledger: CreditSubLedger

  beforeEach(() => {
    ledger = freshLedger()
    ledger.createAccount(WALLET_A, AllocationTier.OG)
  })

  it("replayed unlock with same idempotency key returns same transaction", () => {
    const tx1 = ledger.unlock(WALLET_A, 1_000n, "corr-1", "unlock-key-1")
    const tx2 = ledger.unlock(WALLET_A, 1_000n, "corr-1", "unlock-key-1")
    expect(tx2.tx_id).toBe(tx1.tx_id)

    // Balance should only be debited once
    const account = ledger.getAccount(WALLET_A)!
    expect(account.balances[CreditState.ALLOCATED]).toBe(9_000n)
    expect(account.balances[CreditState.UNLOCKED]).toBe(1_000n)
  })

  it("different idempotency keys create separate transactions", () => {
    const tx1 = ledger.unlock(WALLET_A, 1_000n, "corr-1", "unlock-key-1")
    const tx2 = ledger.unlock(WALLET_A, 1_000n, "corr-2", "unlock-key-2")
    expect(tx2.tx_id).not.toBe(tx1.tx_id)

    const account = ledger.getAccount(WALLET_A)!
    expect(account.balances[CreditState.ALLOCATED]).toBe(8_000n)
    expect(account.balances[CreditState.UNLOCKED]).toBe(2_000n)
  })

  it("idempotent account creation with explicit key", () => {
    const ledger2 = freshLedger()
    const a1 = ledger2.createAccount(WALLET_A, AllocationTier.OG, undefined, undefined, "create-key-1")
    const a2 = ledger2.createAccount(WALLET_A, AllocationTier.OG, undefined, undefined, "create-key-1")
    expect(a2).toBe(a1)
    expect(ledger2.accountCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Nonce Management
// ---------------------------------------------------------------------------

describe("CreditSubLedger — Nonce Management", () => {
  let ledger: CreditSubLedger

  beforeEach(() => {
    ledger = freshLedger()
  })

  it("marks nonce as used and prevents reuse", () => {
    expect(ledger.isNonceUsed("nonce-1")).toBe(false)
    expect(ledger.markNonceUsed("nonce-1")).toBe(true)
    expect(ledger.isNonceUsed("nonce-1")).toBe(true)
    expect(ledger.markNonceUsed("nonce-1")).toBe(false) // replay
  })

  it("different nonces are independent", () => {
    ledger.markNonceUsed("nonce-1")
    expect(ledger.isNonceUsed("nonce-2")).toBe(false)
    expect(ledger.markNonceUsed("nonce-2")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Expire All
// ---------------------------------------------------------------------------

describe("CreditSubLedger — Expire All", () => {
  let ledger: CreditSubLedger

  beforeEach(() => {
    ledger = freshLedger()
    ledger.createAccount(WALLET_A, AllocationTier.OG)
  })

  it("expires all allocated and unlocked credits", () => {
    ledger.unlock(WALLET_A, 3_000n, "corr-1", "unlock-1")
    // Now: ALLOCATED=7000, UNLOCKED=3000

    const txns = ledger.expireAll(WALLET_A, "expire-all")
    expect(txns.length).toBe(2)

    const account = ledger.getAccount(WALLET_A)!
    expect(account.balances[CreditState.ALLOCATED]).toBe(0n)
    expect(account.balances[CreditState.UNLOCKED]).toBe(0n)
    expect(account.balances[CreditState.EXPIRED]).toBe(10_000n)
    expect(ledger.verifyConservation(WALLET_A)).toBe(true)
  })

  it("returns empty array for nonexistent account", () => {
    const txns = ledger.expireAll(WALLET_B, "expire-all")
    expect(txns.length).toBe(0)
  })

  it("does not expire reserved or consumed credits", () => {
    ledger.unlock(WALLET_A, 5_000n, "corr-1", "unlock-1")
    ledger.reserve(WALLET_A, 2_000n, "corr-2", "reserve-1")
    ledger.consume(WALLET_A, 1_000n, "corr-3", "consume-1")
    // ALLOCATED=5000, UNLOCKED=3000, RESERVED=1000, CONSUMED=1000

    const txns = ledger.expireAll(WALLET_A, "expire-all")
    expect(txns.length).toBe(2)

    const account = ledger.getAccount(WALLET_A)!
    expect(account.balances[CreditState.ALLOCATED]).toBe(0n)
    expect(account.balances[CreditState.UNLOCKED]).toBe(0n)
    expect(account.balances[CreditState.RESERVED]).toBe(1_000n) // unchanged
    expect(account.balances[CreditState.CONSUMED]).toBe(1_000n) // unchanged
    expect(account.balances[CreditState.EXPIRED]).toBe(8_000n)
    expect(ledger.verifyConservation(WALLET_A)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Journal Queries
// ---------------------------------------------------------------------------

describe("CreditSubLedger — Journal Queries", () => {
  let ledger: CreditSubLedger

  beforeEach(() => {
    ledger = freshLedger()
  })

  it("tracks transactions per account", () => {
    ledger.createAccount(WALLET_A, AllocationTier.OG)
    ledger.createAccount(WALLET_B, AllocationTier.COMMUNITY)
    ledger.unlock(WALLET_A, 1_000n, "corr-1", "key-1")

    const txnsA = ledger.getTransactions(WALLET_A)
    const txnsB = ledger.getTransactions(WALLET_B)
    expect(txnsA.length).toBe(2) // allocate + unlock
    expect(txnsB.length).toBe(1) // allocate only
  })

  it("getAllTransactions returns all entries", () => {
    ledger.createAccount(WALLET_A, AllocationTier.OG)
    ledger.createAccount(WALLET_B, AllocationTier.COMMUNITY)
    ledger.unlock(WALLET_A, 1_000n, "corr-1", "key-1")

    const all = ledger.getAllTransactions()
    expect(all.length).toBe(3) // 2 allocates + 1 unlock
  })

  it("transactionCount matches journal length", () => {
    ledger.createAccount(WALLET_A, AllocationTier.OG)
    expect(ledger.transactionCount).toBe(1)
    ledger.unlock(WALLET_A, 1_000n, "corr-1", "key-1")
    expect(ledger.transactionCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Account Not Found
// ---------------------------------------------------------------------------

describe("CreditSubLedger — Account Not Found", () => {
  let ledger: CreditSubLedger

  beforeEach(() => {
    ledger = freshLedger()
  })

  it("getAccount returns null for unknown wallet", () => {
    expect(ledger.getAccount(WALLET_A)).toBeNull()
  })

  it("transfer throws for unknown wallet", () => {
    expect(() =>
      ledger.unlock(WALLET_A, 1_000n, "corr-1", "key-1"),
    ).toThrow(CreditLedgerError)
  })

  it("verifyConservation returns false for unknown wallet", () => {
    expect(ledger.verifyConservation(WALLET_A)).toBe(false)
  })
})
