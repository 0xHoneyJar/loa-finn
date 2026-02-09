// tests/finn/redis-budget.test.ts — RedisBudgetEnforcer tests (T-2.9)

import { describe, it, expect, vi } from "vitest"
import { RedisBudgetEnforcer } from "../../src/hounfour/redis/budget.js"
import type { BudgetConfig, BudgetSnapshot } from "../../src/hounfour/redis/budget.js"
import type { RedisStateBackend } from "../../src/hounfour/redis/client.js"

// --- Mock Redis ---

function mockRedis(connected = true) {
  const store = new Map<string, number>()

  const client = {
    incrbyfloat: vi.fn(async (key: string, amount: number) => {
      const current = store.get(key) ?? 0
      const newVal = current + amount
      store.set(key, newVal)
      return String(newVal)
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

const DEFAULT_CONFIG: BudgetConfig = {
  limitUsd: 10.0,
  warningThresholdPercent: 80,
}

// --- Tests ---

describe("RedisBudgetEnforcer", () => {
  describe("recordCost — fail-closed", () => {
    it("records cost via Redis INCRBYFLOAT", async () => {
      const { backend, client, store } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 1.5)

      expect(client.incrbyfloat).toHaveBeenCalledWith(
        "finn:hounfour:budget:agent:finn",
        1.5,
      )
      expect(store.get("finn:hounfour:budget:agent:finn")).toBe(1.5)
    })

    it("accumulates costs across multiple calls", async () => {
      const { backend, store } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 1.0)
      await enforcer.recordCost("agent:finn", 2.5)
      await enforcer.recordCost("agent:finn", 0.3)

      expect(store.get("finn:hounfour:budget:agent:finn")).toBeCloseTo(3.8)
    })

    it("throws when Redis is disconnected", async () => {
      const { backend } = mockRedis(false)
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await expect(enforcer.recordCost("agent:finn", 1.0)).rejects.toThrow("BUDGET_UNAVAILABLE")
    })

    it("throws when Redis is null", async () => {
      const enforcer = new RedisBudgetEnforcer(null, DEFAULT_CONFIG)

      await expect(enforcer.recordCost("agent:finn", 1.0)).rejects.toThrow("BUDGET_UNAVAILABLE")
    })

    it("throws when INCRBYFLOAT fails", async () => {
      const { backend, client } = mockRedis()
      client.incrbyfloat.mockRejectedValue(new Error("Redis timeout"))
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await expect(enforcer.recordCost("agent:finn", 1.0)).rejects.toThrow("BUDGET_UNAVAILABLE")
    })

    it("updates in-memory mirror on success", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 3.0)

      const snapshot = enforcer.getBudgetSnapshot("agent:finn")
      expect(snapshot.spentUsd).toBe(3.0)
    })
  })

  describe("isExceeded — fail-closed", () => {
    it("returns false when under budget", async () => {
      const { backend, store } = mockRedis()
      store.set("finn:hounfour:budget:agent:finn", 5.0)
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      expect(await enforcer.isExceeded("agent:finn")).toBe(false)
    })

    it("returns true when at budget limit", async () => {
      const { backend, store } = mockRedis()
      store.set("finn:hounfour:budget:agent:finn", 10.0)
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      expect(await enforcer.isExceeded("agent:finn")).toBe(true)
    })

    it("returns true when over budget", async () => {
      const { backend, store } = mockRedis()
      store.set("finn:hounfour:budget:agent:finn", 15.0)
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

    it("syncs mirror from Redis read", async () => {
      const { backend, store } = mockRedis()
      store.set("finn:hounfour:budget:agent:finn", 7.5)
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.isExceeded("agent:finn")

      const snapshot = enforcer.getBudgetSnapshot("agent:finn")
      expect(snapshot.spentUsd).toBe(7.5)
    })
  })

  describe("isWarning — advisory", () => {
    it("returns false when under warning threshold", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 7.0) // 70% < 80%
      expect(enforcer.isWarning("agent:finn")).toBe(false)
    })

    it("returns true when at warning threshold", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 8.0) // 80% = 80%
      expect(enforcer.isWarning("agent:finn")).toBe(true)
    })

    it("returns true when above warning threshold", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 9.5)
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

      await enforcer.recordCost("agent:finn", 6.0)

      const snapshot = enforcer.getBudgetSnapshot("agent:finn")
      expect(snapshot).toEqual({
        scopeKey: "agent:finn",
        spentUsd: 6.0,
        limitUsd: 10.0,
        remainingUsd: 4.0,
        exceeded: false,
        warning: false,
      })
    })

    it("shows exceeded and warning when over limit", async () => {
      const { backend } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 12.0)

      const snapshot = enforcer.getBudgetSnapshot("agent:finn")
      expect(snapshot.exceeded).toBe(true)
      expect(snapshot.warning).toBe(true)
      expect(snapshot.remainingUsd).toBe(0)
    })

    it("returns zero-state for unknown scope", () => {
      const enforcer = new RedisBudgetEnforcer(null, DEFAULT_CONFIG)

      const snapshot = enforcer.getBudgetSnapshot("unknown")
      expect(snapshot.spentUsd).toBe(0)
      expect(snapshot.remainingUsd).toBe(10.0)
      expect(snapshot.exceeded).toBe(false)
      expect(snapshot.warning).toBe(false)
    })
  })

  describe("syncFromRedis", () => {
    it("loads values from Redis into mirror", async () => {
      const { backend, store } = mockRedis()
      store.set("finn:hounfour:budget:agent:finn", 4.2)
      store.set("finn:hounfour:budget:agent:other", 1.0)

      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)
      await enforcer.syncFromRedis(["agent:finn", "agent:other"])

      expect(enforcer.getBudgetSnapshot("agent:finn").spentUsd).toBe(4.2)
      expect(enforcer.getBudgetSnapshot("agent:other").spentUsd).toBe(1.0)
    })

    it("skips when Redis unavailable", async () => {
      const enforcer = new RedisBudgetEnforcer(null, DEFAULT_CONFIG)
      await enforcer.syncFromRedis(["agent:finn"])

      // Should not throw, mirror stays at 0
      expect(enforcer.getBudgetSnapshot("agent:finn").spentUsd).toBe(0)
    })

    it("handles individual key errors gracefully", async () => {
      const { backend, client, store } = mockRedis()
      store.set("finn:hounfour:budget:scope-ok", 2.0)
      // Make GET fail for the second key
      let callCount = 0
      client.get.mockImplementation(async (key: string) => {
        callCount++
        if (callCount === 2) throw new Error("Redis error")
        const val = store.get(key)
        return val !== undefined ? String(val) : null
      })

      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)
      await enforcer.syncFromRedis(["scope-ok", "scope-fail"])

      expect(enforcer.getBudgetSnapshot("scope-ok").spentUsd).toBe(2.0)
      // scope-fail stays at 0 (non-fatal)
      expect(enforcer.getBudgetSnapshot("scope-fail").spentUsd).toBe(0)
    })
  })

  describe("reconcile", () => {
    it("reports zero drift when Redis matches mirror", async () => {
      const { backend, store } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      // Record so mirror has a value
      await enforcer.recordCost("agent:finn", 5.0)

      const result = await enforcer.reconcile()
      expect(result.scopes).toHaveLength(1)
      expect(result.scopes[0].driftPercent).toBe(0)
      expect(result.scopes[0].alert).toBe(false)
    })

    it("detects drift when Redis and mirror diverge", async () => {
      const { backend, store } = mockRedis()
      const enforcer = new RedisBudgetEnforcer(backend, DEFAULT_CONFIG)

      await enforcer.recordCost("agent:finn", 5.0)

      // Tamper Redis value directly
      store.set("finn:hounfour:budget:agent:finn", 6.0)

      const result = await enforcer.reconcile()
      expect(result.scopes[0].driftPercent).toBe(20) // |6.0 - 5.0| / 5.0 * 100
      expect(result.scopes[0].alert).toBe(true) // >1%
    })

    it("returns empty scopes when no budgets tracked", async () => {
      const enforcer = new RedisBudgetEnforcer(null, DEFAULT_CONFIG)
      const result = await enforcer.reconcile()
      expect(result.scopes).toHaveLength(0)
    })
  })
})
