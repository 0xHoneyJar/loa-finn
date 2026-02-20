// tests/credits/consumption.test.ts — Credit Consumption State Machine Tests (Sprint 22 Task 22.1)

import { describe, it, expect, beforeEach } from "vitest"
import {
  reserveCredits,
  finalizeReservation,
  rollbackReservation,
  resetReservationCounter,
  type CreditStore,
  type CreditAccount,
  type ReservationReceipt,
} from "../../src/credits/consumption.js"

// ---------------------------------------------------------------------------
// In-Memory Store
// ---------------------------------------------------------------------------

class MemoryCreditStore implements CreditStore {
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
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Credit Consumption State Machine", () => {
  let store: MemoryCreditStore

  beforeEach(() => {
    store = new MemoryCreditStore()
    resetReservationCounter()
  })

  describe("reserveCredits", () => {
    it("returns credits_locked when credits are allocated but not unlocked", async () => {
      store.accounts.set("0xAlice", {
        wallet: "0xAlice",
        allocated: 100,
        unlocked: 0,
        reserved: 0,
        consumed: 0,
        expired: 0,
      })

      const result = await reserveCredits(store, "0xAlice", 1)
      expect(result.status).toBe("credits_locked")
      if (result.status === "credits_locked") {
        expect(result.code).toBe(402)
      }
    })

    it("reserves credits when unlocked balance is sufficient", async () => {
      store.accounts.set("0xBob", {
        wallet: "0xBob",
        allocated: 0,
        unlocked: 50,
        reserved: 0,
        consumed: 0,
        expired: 0,
      })

      const result = await reserveCredits(store, "0xBob", 5)
      expect(result.status).toBe("reserved")
      if (result.status === "reserved") {
        expect(result.receipt.amount).toBe(5)
        expect(result.receipt.wallet).toBe("0xBob")
      }

      // Verify account state
      const account = await store.getAccount("0xBob")
      expect(account!.unlocked).toBe(45)
      expect(account!.reserved).toBe(5)
    })

    it("returns fallback_usdc when no account exists", async () => {
      const result = await reserveCredits(store, "0xUnknown", 1)
      expect(result.status).toBe("fallback_usdc")
    })

    it("returns fallback_usdc when credits exhausted", async () => {
      store.accounts.set("0xCharlie", {
        wallet: "0xCharlie",
        allocated: 0,
        unlocked: 0,
        reserved: 0,
        consumed: 100,
        expired: 0,
      })

      const result = await reserveCredits(store, "0xCharlie", 1)
      expect(result.status).toBe("fallback_usdc")
    })

    it("returns fallback_usdc when insufficient balance", async () => {
      store.accounts.set("0xDave", {
        wallet: "0xDave",
        allocated: 0,
        unlocked: 3,
        reserved: 0,
        consumed: 0,
        expired: 0,
      })

      const result = await reserveCredits(store, "0xDave", 5)
      expect(result.status).toBe("fallback_usdc")
    })
  })

  describe("finalizeReservation", () => {
    it("moves credits from reserved to consumed", async () => {
      store.accounts.set("0xEve", {
        wallet: "0xEve",
        allocated: 0,
        unlocked: 45,
        reserved: 5,
        consumed: 0,
        expired: 0,
      })
      store.reservations.set("rsv-1", {
        reservationId: "rsv-1",
        wallet: "0xEve",
        amount: 5,
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      })

      const result = await finalizeReservation(store, "rsv-1")
      expect(result.status).toBe("consumed")
      if (result.status === "consumed") {
        expect(result.amount).toBe(5)
      }

      const account = await store.getAccount("0xEve")
      expect(account!.reserved).toBe(0)
      expect(account!.consumed).toBe(5)
    })

    it("returns reservation_not_found for unknown reservation", async () => {
      const result = await finalizeReservation(store, "rsv-unknown")
      expect(result.status).toBe("reservation_not_found")
    })
  })

  describe("rollbackReservation", () => {
    it("moves credits from reserved back to unlocked", async () => {
      store.accounts.set("0xFrank", {
        wallet: "0xFrank",
        allocated: 0,
        unlocked: 40,
        reserved: 10,
        consumed: 0,
        expired: 0,
      })
      store.reservations.set("rsv-2", {
        reservationId: "rsv-2",
        wallet: "0xFrank",
        amount: 10,
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      })

      const result = await rollbackReservation(store, "rsv-2")
      expect(result.status).toBe("rolled_back")
      if (result.status === "rolled_back") {
        expect(result.amount).toBe(10)
      }

      const account = await store.getAccount("0xFrank")
      expect(account!.reserved).toBe(0)
      expect(account!.unlocked).toBe(50)
    })

    it("returns reservation_not_found for unknown reservation", async () => {
      const result = await rollbackReservation(store, "rsv-unknown")
      expect(result.status).toBe("reservation_not_found")
    })
  })

  describe("Full lifecycle: reserve → finalize", () => {
    it("completes the full credit consumption lifecycle", async () => {
      store.accounts.set("0xGrace", {
        wallet: "0xGrace",
        allocated: 0,
        unlocked: 100,
        reserved: 0,
        consumed: 0,
        expired: 0,
      })

      // Reserve
      const reserveResult = await reserveCredits(store, "0xGrace", 10)
      expect(reserveResult.status).toBe("reserved")
      const receipt = reserveResult.status === "reserved" ? reserveResult.receipt : null
      expect(receipt).toBeTruthy()

      // Verify intermediate state
      let account = await store.getAccount("0xGrace")
      expect(account!.unlocked).toBe(90)
      expect(account!.reserved).toBe(10)

      // Finalize
      const finalResult = await finalizeReservation(store, receipt!.reservationId)
      expect(finalResult.status).toBe("consumed")

      // Verify final state
      account = await store.getAccount("0xGrace")
      expect(account!.unlocked).toBe(90)
      expect(account!.reserved).toBe(0)
      expect(account!.consumed).toBe(10)
    })
  })

  describe("Full lifecycle: reserve → rollback", () => {
    it("rolls back credits on failure", async () => {
      store.accounts.set("0xHeidi", {
        wallet: "0xHeidi",
        allocated: 0,
        unlocked: 50,
        reserved: 0,
        consumed: 0,
        expired: 0,
      })

      // Reserve
      const reserveResult = await reserveCredits(store, "0xHeidi", 5)
      expect(reserveResult.status).toBe("reserved")
      const receipt = reserveResult.status === "reserved" ? reserveResult.receipt : null

      // Rollback
      const rollbackResult = await rollbackReservation(store, receipt!.reservationId)
      expect(rollbackResult.status).toBe("rolled_back")

      // Verify credits are restored
      const account = await store.getAccount("0xHeidi")
      expect(account!.unlocked).toBe(50)
      expect(account!.reserved).toBe(0)
    })
  })
})
