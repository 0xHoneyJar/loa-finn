// tests/finn/redis-budget.test.ts — RedisBudgetEnforcer tests (T-2.9, updated for T-A.5 micro-USD)

import { describe, it, expect, vi } from "vitest"
import { RedisBudgetEnforcer } from "../../src/hounfour/redis/budget.js"
import type { BudgetConfig } from "../../src/hounfour/redis/budget.js"
import type { RedisStateBackend } from "../../src/hounfour/redis/client.js"

// --- Mock Redis ---

function mockRedis(connected = true) {
  const store = new Map<string, number>()

  const client = {
    incrby: vi.fn(async (key: string, amount: number) => {
      const current = store.get(key) ?? 0
      const newVal = current + amount
      store.set(key, newVal)
      return newVal
    }),
    get: vi.fn(async (key: string) => {
      const val = store.get(key)
      return val !== undefined ? String(val) : null
    }),
  }

  const backend = {
    isConnected: vi.fn(() => connected),
    key: vi.fn((...parts: string[]) => `finn:hounfour:${parts.join(":")}`),
    getClient: vi.fn(() => client),
  } as unknown as RedisStateBackend

  return { backend, client, store }
}

// 10 USD = 10,000,000 micro-USD
const DEFAULT_CONFIG: BudgetConfig = {
  limitMicro: 10_000_000,
  warningThresholdPercent: 80,
}

// --- Tests ---

describe("RedisBudgetEnforcer", () => {
  describe("recordCost — fail-closed", () => {
    it("records cost via Redis INCRBY (integer micro-USD)", async () => {
      const { backend, client, store } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 1_500_000) // 1.5 USD in micro

      expect(client.incrby).toHaveBeenCalledWith(
        "finn:hounfour:budget:agent:finn:spent_micro",
        1_500_000,
      )
    })

    it("accumulates costs across multiple calls", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 1_000_000)
      await enforcer.recordCost("agent:finn", 2_500_000)
      await enforcer.recordCost("agent:finn", 300_000)

      const snapshot = enforcer.getBudgetSnapshot("agent:finn")
      expect(snapshot.spentMicro).toBe(3_800_000)
    })

    it("throws when Redis is disconnected", async () => {
      const { backend } = mockRedis(false)
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await expect(enforcer.recordCost("agent:finn", 1_000_000)).rejects.toThrow("BUDGET_UNAVAILABLE")
    })

    it("throws when Redis is null", async () => {
      const enforcer = new RedisBudgetEnforcer(null, DEFAULT_CONFIG)

      await expect(enforcer.recordCost("agent:finn", 1_000_000)).rejects.toThrow("BUDGET_UNAVAILABLE")
    })

    it("throws when INCRBY fails", async () => {
      const { backend, client } = mockRedis()
      client.incrby.mockRejectedValue(new Error("Redis timeout"))
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await expect(enforcer.recordCost("agent:finn", 1_000_000)).rejects.toThrow("BUDGET_UNAVAILABLE")
    })

    it("rejects non-integer costMicro", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await expect(enforcer.recordCost("agent:finn", 1.5)).rejects.toThrow("BUDGET_INVALID")
    })

    it("rejects negative costMicro", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await expect(enforcer.recordCost("agent:finn", -100)).rejects.toThrow("BUDGET_INVALID")
    })

    it("updates in-memory mirror on success", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 3_000_000)

      const snapshot = enforcer.getBudgetSnapshot("agent:finn")
      expect(snapshot.spentMicro).toBe(3_000_000)
    })
  })

  describe("isExceeded — fail-closed", () => {
    it("returns false when under budget", async () => {
      const { backend, store } = mockRedis()
      store.set("finn:hounfour:budget:agent:finn:spent_micro", 5_000_000)
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      expect(await enforcer.isExceeded("agent:finn")).toBe(false)
    })

    it("returns true when at budget limit", async () => {
      const { backend, store } = mockRedis()
      store.set("finn:hounfour:budget:agent:finn:spent_micro", 10_000_000)
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      expect(await enforcer.isExceeded("agent:finn")).toBe(true)
    })

    it("returns true when over budget", async () => {
      const { backend, store } = mockRedis()
      store.set("finn:hounfour:budget:agent:finn:spent_micro", 15_000_000)
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      expect(await enforcer.isExceeded("agent:finn")).toBe(true)
    })

    it("returns true when Redis disconnected (fail-closed)", async () => {
      const { backend } = mockRedis(false)
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      expect(await enforcer.isExceeded("agent:finn")).toBe(true)
    })

    it("returns true when Redis GET fails (fail-closed)", async () => {
      const { backend, client } = mockRedis()
      client.get.mockRejectedValue(new Error("Redis timeout"))
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      expect(await enforcer.isExceeded("agent:finn")).toBe(true)
    })

    it("returns false for unknown scope (no spend)", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      expect(await enforcer.isExceeded("unknown:scope")).toBe(false)
    })

    it("returns true when Redis value is non-numeric (fail-closed NaN guard)", async () => {
      const { backend, client } = mockRedis()
      // Simulate corrupted Redis data
      client.get.mockResolvedValue("not-a-number")
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      expect(await enforcer.isExceeded("agent:finn")).toBe(true)
    })

    it("syncs mirror from Redis read", async () => {
      const { backend, store } = mockRedis()
      store.set("finn:hounfour:budget:agent:finn:spent_micro", 7_500_000)
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.isExceeded("agent:finn")

      const snapshot = enforcer.getBudgetSnapshot("agent:finn")
      expect(snapshot.spentMicro).toBe(7_500_000)
    })
  })

  describe("isWarning — advisory", () => {
    it("returns false when under warning threshold", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 7_000_000) // 70% < 80%
      expect(enforcer.isWarning("agent:finn")).toBe(false)
    })

    it("returns true when at warning threshold", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 8_000_000) // 80% = 80%
      expect(enforcer.isWarning("agent:finn")).toBe(true)
    })

    it("returns true when above warning threshold", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 9_500_000)
      expect(enforcer.isWarning("agent:finn")).toBe(true)
    })

    it("returns false for unknown scope", () => {
      const enforcer = new RedisBudgetEnforcer(null, DEFAULT_CONFIG)
      expect(enforcer.isWarning("unknown")).toBe(false)
    })
  })

  describe("getBudgetSnapshot", () => {
    it("returns correct snapshot with all fields", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 6_000_000)

      const snapshot = enforcer.getBudgetSnapshot("agent:finn")
      expect(snapshot.spentMicro).toBe(6_000_000)
      expect(snapshot.limitMicro).toBe(10_000_000)
      expect(snapshot.remainingMicro).toBe(4_000_000)
      expect(snapshot.exceeded).toBe(false)
      expect(snapshot.warning).toBe(false)
      // Deprecated compat fields
      expect(snapshot.spentUsd).toBe(6)
      expect(snapshot.limitUsd).toBe(10)
      expect(snapshot.remainingUsd).toBe(4)
    })

    it("shows exceeded and warning when over limit", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 12_000_000)

      const snapshot = enforcer.getBudgetSnapshot("agent:finn")
      expect(snapshot.exceeded).toBe(true)
      expect(snapshot.warning).toBe(true)
      expect(snapshot.remainingMicro).toBe(0)
    })

    it("returns zero-state for unknown scope", () => {
      const enforcer = new RedisBudgetEnforcer(null, DEFAULT_CONFIG)

      const snapshot = enforcer.getBudgetSnapshot("unknown")
      expect(snapshot.spentMicro).toBe(0)
      expect(snapshot.remainingMicro).toBe(10_000_000)
      expect(snapshot.exceeded).toBe(false)
      expect(snapshot.warning).toBe(false)
    })
  })

  describe("syncFromRedis", () => {
    it("loads values from Redis into mirror", async () => {
      const { backend, store } = mockRedis()
      store.set("finn:hounfour:budget:agent:finn:spent_micro", 4_200_000)
      store.set("finn:hounfour:budget:agent:other:spent_micro", 1_000_000)

      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)
      await enforcer.syncFromRedis(["agent:finn", "agent:other"])

      expect(enforcer.getBudgetSnapshot("agent:finn").spentMicro).toBe(4_200_000)
      expect(enforcer.getBudgetSnapshot("agent:other").spentMicro).toBe(1_000_000)
    })

    it("skips when Redis unavailable", async () => {
      const enforcer = new RedisBudgetEnforcer(null, DEFAULT_CONFIG)
      await enforcer.syncFromRedis(["agent:finn"])

      expect(enforcer.getBudgetSnapshot("agent:finn").spentMicro).toBe(0)
    })

    it("skips NaN values during sync (non-numeric Redis data)", async () => {
      const { backend, client } = mockRedis()
      let callCount = 0
      client.get.mockImplementation(async () => {
        callCount++
        if (callCount === 1) return "corrupted-data"
        return "3_000_000" // valid for second call
      })

      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)
      await enforcer.syncFromRedis(["bad-scope", "good-scope"])

      // NaN value should be skipped (mirror stays at 0)
      expect(enforcer.getBudgetSnapshot("bad-scope").spentMicro).toBe(0)
    })

    it("handles individual key errors gracefully", async () => {
      const { backend, client, store } = mockRedis()
      store.set("finn:hounfour:budget:scope-ok:spent_micro", 2_000_000)
      let callCount = 0
      client.get.mockImplementation(async (key: string) => {
        callCount++
        if (callCount === 2) throw new Error("Redis error")
        const val = store.get(key)
        return val !== undefined ? String(val) : null
      })

      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)
      await enforcer.syncFromRedis(["scope-ok", "scope-fail"])

      expect(enforcer.getBudgetSnapshot("scope-ok").spentMicro).toBe(2_000_000)
      expect(enforcer.getBudgetSnapshot("scope-fail").spentMicro).toBe(0)
    })
  })

  describe("reconcile", () => {
    it("reports zero drift when Redis matches mirror", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 5_000_000)

      const result = await enforcer.reconcile()
      expect(result.scopes).toHaveLength(1)
      expect(result.scopes[0].driftPercent).toBe(0)
      expect(result.scopes[0].alert).toBe(false)
    })

    it("detects drift when Redis and mirror diverge", async () => {
      const { backend, store } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 5_000_000)

      // Tamper Redis value directly
      store.set("finn:hounfour:budget:agent:finn:spent_micro", 6_000_000)

      const result = await enforcer.reconcile()
      expect(result.scopes[0].driftPercent).toBe(20) // |6M - 5M| / 5M * 100
      expect(result.scopes[0].alert).toBe(true)
    })

    it("returns empty scopes when no budgets tracked", async () => {
      const enforcer = new RedisBudgetEnforcer(null, DEFAULT_CONFIG)
      const result = await enforcer.reconcile()
      expect(result.scopes).toHaveLength(0)
    })
  })
})
