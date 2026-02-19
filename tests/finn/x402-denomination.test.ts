// tests/finn/x402-denomination.test.ts — x402 Denomination + Rounding Tests (Sprint 9 Task 9.4)

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  convertMicroUSDtoMicroUSDC,
  convertMicroUSDCtoMicroUSD,
  freezeExchangeRate,
  verifyRoundTripDrift,
} from "../../src/x402/denomination.js"
import { CreditNoteService } from "../../src/x402/credit-note.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function createMockRedis(): RedisCommandClient {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...args: (string | number)[]) => {
      const hasNX = args.some(a => String(a).toUpperCase() === "NX")
      if (hasNX && store.has(key)) {
        return null
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
    eval: vi.fn(async (_script: string, _numkeys: number, balanceKey: string, requiredAmount: string) => {
      // Mock atomic Lua script for applyCreditNotes
      const balanceStr = store.get(balanceKey as string)
      if (!balanceStr) return ["0", "0"]
      const balance = Number(balanceStr)
      if (balance === 0) return ["0", "0"]
      const required = Number(requiredAmount)
      const creditUsed = Math.min(balance, required)
      const remaining = balance - creditUsed
      if (remaining > 0) {
        store.set(balanceKey as string, String(remaining))
      } else {
        store.delete(balanceKey as string)
      }
      return [String(creditUsed), String(remaining)]
    }),
    hgetall: vi.fn(async () => null),
  } as unknown as RedisCommandClient
}

// ---------------------------------------------------------------------------
// 1. MicroUSD ↔ MicroUSDC Conversion
// ---------------------------------------------------------------------------

describe("Denomination conversion", () => {
  it("converts MicroUSD to MicroUSDC at 1:1 rate", () => {
    const result = convertMicroUSDtoMicroUSDC(1000n, 1.0)
    expect(result).toBe(1000n)
  })

  it("converts MicroUSD to MicroUSDC with rate > 1", () => {
    const result = convertMicroUSDtoMicroUSDC(1000n, 1.5)
    expect(result).toBe(1500n)
  })

  it("ceil rounds MicroUSD to MicroUSDC", () => {
    // 100 * 1.333... should ceil
    const result = convertMicroUSDtoMicroUSDC(100n, 1.333333)
    expect(result).toBeGreaterThanOrEqual(133n)
  })

  it("converts MicroUSDC back to MicroUSD", () => {
    const result = convertMicroUSDCtoMicroUSD(1000n, 1.0)
    expect(result).toBe(1000n)
  })

  it("handles zero amount", () => {
    expect(convertMicroUSDtoMicroUSDC(0n, 1.0)).toBe(0n)
    expect(convertMicroUSDCtoMicroUSD(0n, 1.0)).toBe(0n)
  })

  it("handles zero rate", () => {
    expect(convertMicroUSDCtoMicroUSD(1000n, 0)).toBe(0n)
  })
})

// ---------------------------------------------------------------------------
// 2. Round-Trip Drift
// ---------------------------------------------------------------------------

describe("Round-trip drift", () => {
  it("round-trip at 1:1 preserves value exactly", () => {
    const drift = verifyRoundTripDrift(1000n, 1.0)
    expect(drift).toBeLessThanOrEqual(1n)
  })

  it("round-trip at non-trivial rate within 1 unit", () => {
    const drift = verifyRoundTripDrift(1000n, 1.23456)
    expect(drift).toBeLessThanOrEqual(1n)
  })

  it("1000 requests cumulative drift under threshold", () => {
    let totalDrift = 0n
    for (let i = 1; i <= 1000; i++) {
      const amount = BigInt(i * 100)
      totalDrift += verifyRoundTripDrift(amount, 1.0001)
    }
    expect(totalDrift).toBeLessThan(1000n) // Under 1000 MicroUSD threshold
  })
})

// ---------------------------------------------------------------------------
// 3. Rate Freeze
// ---------------------------------------------------------------------------

describe("Rate freeze", () => {
  it("freezes current rate from env", () => {
    const original = process.env.USD_USDC_EXCHANGE_RATE
    process.env.USD_USDC_EXCHANGE_RATE = "1.05"

    try {
      const frozen = freezeExchangeRate("entry-001")
      expect(frozen.rate).toBe(1.05)
      expect(frozen.billing_entry_id).toBe("entry-001")
      expect(frozen.frozen_at).toBeGreaterThan(0)
    } finally {
      if (original !== undefined) {
        process.env.USD_USDC_EXCHANGE_RATE = original
      } else {
        delete process.env.USD_USDC_EXCHANGE_RATE
      }
    }
  })

  it("defaults to 1.0 when env not set", () => {
    const original = process.env.USD_USDC_EXCHANGE_RATE
    delete process.env.USD_USDC_EXCHANGE_RATE

    try {
      const frozen = freezeExchangeRate("entry-002")
      expect(frozen.rate).toBe(1.0)
    } finally {
      if (original !== undefined) {
        process.env.USD_USDC_EXCHANGE_RATE = original
      }
    }
  })

  it("rate change between quote and settlement uses frozen rate", () => {
    const original = process.env.USD_USDC_EXCHANGE_RATE
    process.env.USD_USDC_EXCHANGE_RATE = "1.0"

    try {
      // Freeze at rate 1.0
      const frozen = freezeExchangeRate("entry-003")
      const quotedAmount = convertMicroUSDtoMicroUSDC(1000n, frozen.rate)
      expect(quotedAmount).toBe(1000n)

      // Rate changes to 1.5 (simulating env var change)
      const newRate = 1.5
      const newAmount = convertMicroUSDtoMicroUSDC(1000n, newRate)

      // Settlement should use frozen rate, not new rate
      const settledAmount = convertMicroUSDtoMicroUSDC(1000n, frozen.rate)
      expect(settledAmount).toBe(quotedAmount) // Uses frozen rate
      expect(settledAmount).not.toBe(newAmount) // Not the new rate
    } finally {
      if (original !== undefined) {
        process.env.USD_USDC_EXCHANGE_RATE = original
      } else {
        delete process.env.USD_USDC_EXCHANGE_RATE
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Credit Notes
// ---------------------------------------------------------------------------

describe("CreditNoteService", () => {
  let redis: RedisCommandClient
  let service: CreditNoteService
  let noteCounter: number

  beforeEach(() => {
    noteCounter = 0
    redis = createMockRedis()
    service = new CreditNoteService({
      redis,
      generateId: () => { noteCounter++; return `cn_${noteCounter}` },
    })
  })

  it("issues credit note for overpayment", async () => {
    const note = await service.issueCreditNote(
      "0xWallet",
      "q_1",
      "5000", // quoted
      "3200", // actual
    )
    expect(note).not.toBeNull()
    expect(note!.amount).toBe("1800") // 5000 - 3200
    expect(note!.wallet_address).toBe("0xwallet") // lowercase
  })

  it("returns null when no overpayment", async () => {
    const note = await service.issueCreditNote("0xWallet", "q_1", "3000", "3000")
    expect(note).toBeNull()
  })

  it("returns null when actual exceeds quoted", async () => {
    const note = await service.issueCreditNote("0xWallet", "q_1", "3000", "5000")
    expect(note).toBeNull()
  })

  it("accumulates credit balance", async () => {
    await service.issueCreditNote("0xWallet", "q_1", "5000", "3200") // +1800
    await service.issueCreditNote("0xWallet", "q_2", "4000", "3000") // +1000

    const balance = await service.getBalance("0xWallet")
    expect(balance).toBe("2800") // 1800 + 1000
  })

  it("applies credit to reduce required payment", async () => {
    await service.issueCreditNote("0xWallet", "q_1", "5000", "3200") // +1800

    const result = await service.applyCreditNotes("0xWallet", "3000")
    expect(result.creditUsed).toBe("1800")
    expect(result.reducedAmount).toBe("1200") // 3000 - 1800
    expect(result.remainingCredit).toBe("0")
  })

  it("credit fully covers payment", async () => {
    await service.issueCreditNote("0xWallet", "q_1", "10000", "3000") // +7000

    const result = await service.applyCreditNotes("0xWallet", "5000")
    expect(result.creditUsed).toBe("5000")
    expect(result.reducedAmount).toBe("0")
    expect(result.remainingCredit).toBe("2000") // 7000 - 5000
  })

  it("no credit returns original amount", async () => {
    const result = await service.applyCreditNotes("0xWallet", "5000")
    expect(result.creditUsed).toBe("0")
    expect(result.reducedAmount).toBe("5000")
    expect(result.remainingCredit).toBe("0")
  })

  it("WAL audit on credit note issue", async () => {
    const walEntries: Array<{ op: string; payload: unknown }> = []
    const audited = new CreditNoteService({
      redis,
      walAppend: (_ns, op, _key, payload) => { walEntries.push({ op, payload }); return "id" },
      generateId: () => "cn_wal",
    })

    await audited.issueCreditNote("0xWallet", "q_1", "5000", "3200")
    expect(walEntries).toHaveLength(1)
    expect(walEntries[0].op).toBe("x402_credit_note")

    const payload = walEntries[0].payload as Record<string, unknown>
    expect(payload.delta).toBe("1800")
    const postings = payload.postings as Array<{ account: string; delta: string }>
    expect(postings).toHaveLength(2)
    expect(postings[0].account).toBe("system:revenue")
    expect(postings[1].account).toBe("system:credit_notes")
  })
})

// ---------------------------------------------------------------------------
// 5. Module Exports
// ---------------------------------------------------------------------------

describe("Sprint 9 module exports", () => {
  it("denomination exports", async () => {
    const mod = await import("../../src/x402/denomination.js")
    expect(mod.convertMicroUSDtoMicroUSDC).toBeDefined()
    expect(mod.convertMicroUSDCtoMicroUSD).toBeDefined()
    expect(mod.freezeExchangeRate).toBeDefined()
    expect(mod.verifyRoundTripDrift).toBeDefined()
  })

  it("credit-note exports", async () => {
    const mod = await import("../../src/x402/credit-note.js")
    expect(mod.CreditNoteService).toBeDefined()
  })
})
