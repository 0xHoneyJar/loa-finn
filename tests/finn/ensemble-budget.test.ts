// tests/finn/ensemble-budget.test.ts — Ensemble Budget Reservation (Task 3.6)
// Atomic N-branch reservation, per-branch commit, crash recovery TTL, idempotency.

import { describe, it, expect, beforeEach } from "vitest"
import {
  EnsembleBudgetReserver,
  type EnsembleReservation,
} from "../../src/hounfour/redis/ensemble-budget.js"
import type { RedisStateBackend, RedisCommandClient } from "../../src/hounfour/redis/client.js"

// --- Mock Redis with Hash Support ---

class MockRedisClient {
  private store = new Map<string, string>()
  private hashes = new Map<string, Map<string, string>>()
  private ttls = new Map<string, number>()

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<string | null> {
    this.store.set(key, value)
    return "OK"
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0
    for (const key of keys) {
      if (this.store.delete(key)) deleted++
      if (this.hashes.delete(key)) deleted++
      this.ttls.delete(key)
    }
    return deleted
  }

  async incrby(key: string, increment: number): Promise<number> {
    const current = parseInt(this.store.get(key) ?? "0", 10)
    const newVal = current + increment
    this.store.set(key, String(newVal))
    return newVal
  }

  async incrbyfloat(key: string, increment: number): Promise<string> {
    return String(parseFloat(this.store.get(key) ?? "0") + increment)
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (this.store.has(key) || this.hashes.has(key)) {
      this.ttls.set(key, seconds)
      return 1
    }
    return 0
  }

  async exists(...keys: string[]): Promise<number> {
    return keys.filter(k => this.store.has(k) || this.hashes.has(k)).length
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key)
    if (!hash) return {}
    return Object.fromEntries(hash)
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map())
    const isNew = !this.hashes.get(key)!.has(field) ? 1 : 0
    this.hashes.get(key)!.set(field, value)
    return isNew
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const hash = this.hashes.get(key)
    if (!hash) return 0
    let deleted = 0
    for (const f of fields) {
      if (hash.delete(f)) deleted++
    }
    return deleted
  }

  async hlen(key: string): Promise<number> {
    return this.hashes.get(key)?.size ?? 0
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> { return 0 }
  async zadd(key: string, score: number, member: string): Promise<number> { return 0 }
  async zpopmin(key: string, count?: number): Promise<string[]> { return [] }
  async zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number> { return 0 }
  async zcard(key: string): Promise<number> { return 0 }
  async publish(channel: string, message: string): Promise<number> { return 0 }
  async ping(): Promise<string> { return "PONG" }
  async quit(): Promise<string> { return "OK" }

  /**
   * Simulate Redis EVAL for ensemble Lua scripts.
   * Detects which script by numkeys (3 = reserve, 2 = commit).
   */
  async eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    const keys = args.slice(0, numkeys).map(String)
    const argv = args.slice(numkeys).map(String)

    if (numkeys === 3) {
      return this.evalReserve(keys, argv)
    } else if (numkeys === 2) {
      return this.evalCommit(keys, argv)
    }
    throw new Error(`Unknown Lua script with ${numkeys} keys`)
  }

  private evalReserve(keys: string[], argv: string[]): string {
    const spentKey = keys[0]
    const limitKey = keys[1]
    const reservedKey = keys[2]
    const totalReserve = parseInt(argv[0], 10)

    // Check idempotency
    const existingLen = this.hashes.get(reservedKey)?.size ?? 0
    if (existingLen > 0) {
      const spent = parseInt(this.store.get(spentKey) ?? "0", 10)
      return JSON.stringify({ ok: true, idempotent: true, budget_after: spent })
    }

    const spent = parseInt(this.store.get(spentKey) ?? "0", 10)
    const limit = parseInt(this.store.get(limitKey) ?? "0", 10)

    // Budget check (limit=0 means unlimited)
    if (limit > 0 && spent + totalReserve > limit) {
      return JSON.stringify({ ok: false, reason: "BUDGET_EXCEEDED", spent, limit })
    }

    // Reserve: increment spent
    this.store.set(spentKey, String(spent + totalReserve))

    // Store per-branch reservations
    if (!this.hashes.has(reservedKey)) this.hashes.set(reservedKey, new Map())
    for (let i = 1; i < argv.length; i++) {
      this.hashes.get(reservedKey)!.set(String(i - 1), argv[i])
    }

    // TTL
    this.ttls.set(reservedKey, 300)

    return JSON.stringify({
      ok: true,
      idempotent: false,
      budget_after: spent + totalReserve,
    })
  }

  private evalCommit(keys: string[], argv: string[]): string {
    const spentKey = keys[0]
    const reservedKey = keys[1]
    const branchIndex = argv[0]
    const actualCost = parseInt(argv[1], 10)

    const hash = this.hashes.get(reservedKey)
    const reserved = parseInt(hash?.get(branchIndex) ?? "0", 10)
    const refund = reserved - actualCost

    if (refund > 0) {
      const current = parseInt(this.store.get(spentKey) ?? "0", 10)
      this.store.set(spentKey, String(current - refund))
    }

    hash?.delete(branchIndex)
    if (hash && hash.size === 0) {
      this.hashes.delete(reservedKey)
    }

    return JSON.stringify({ refund, actual: actualCost, reserved })
  }

  // Inspection helpers for tests
  getStoreValue(key: string): string | undefined { return this.store.get(key) }
  getHashSize(key: string): number { return this.hashes.get(key)?.size ?? 0 }
  getTTL(key: string): number | undefined { return this.ttls.get(key) }
}

// --- Test Setup ---

let mockClient: MockRedisClient
let mockBackend: RedisStateBackend
let reserver: EnsembleBudgetReserver

function setup() {
  mockClient = new MockRedisClient()
  mockBackend = {
    isConnected: () => true,
    getClient: () => mockClient as unknown as RedisCommandClient,
    key: (component: string, ...parts: string[]) =>
      `finn:hounfour:${component}:${parts.join(":")}`,
  } as unknown as RedisStateBackend

  reserver = new EnsembleBudgetReserver({ redis: mockBackend })
}

// --- Tests ---

describe("EnsembleBudgetReserver", () => {
  beforeEach(setup)

  describe("reserve()", () => {
    it("reserves budget for N branches atomically", async () => {
      const reservation: EnsembleReservation = {
        ensembleId: "ens-001",
        tenantId: "tenant-abc",
        branchReservations: [1000, 1500, 2000],
      }

      const result = await reserver.reserve(reservation)

      expect(result.ok).toBe(true)
      expect(result.idempotent).toBe(false)
      expect(result.budgetAfter).toBe(4500) // sum of all branches
    })

    it("returns BUDGET_EXCEEDED when limit exceeded", async () => {
      // Set a budget limit
      const spentKey = "finn:hounfour:budget:tenant-abc:spent_micro"
      const limitKey = "finn:hounfour:budget:tenant-abc:budget_limit_micro"
      await mockClient.set(spentKey, "9000")
      await mockClient.set(limitKey, "10000")

      const reservation: EnsembleReservation = {
        ensembleId: "ens-002",
        tenantId: "tenant-abc",
        branchReservations: [500, 500, 500],
      }

      const result = await reserver.reserve(reservation)

      expect(result.ok).toBe(false)
      expect(result.reason).toBe("BUDGET_EXCEEDED")
    })

    it("allows reservation when within budget limit", async () => {
      const limitKey = "finn:hounfour:budget:tenant-abc:budget_limit_micro"
      await mockClient.set(limitKey, "10000")

      const reservation: EnsembleReservation = {
        ensembleId: "ens-003",
        tenantId: "tenant-abc",
        branchReservations: [3000, 3000],
      }

      const result = await reserver.reserve(reservation)

      expect(result.ok).toBe(true)
      expect(result.budgetAfter).toBe(6000)
    })

    it("allows unlimited budget when limit is 0", async () => {
      const reservation: EnsembleReservation = {
        ensembleId: "ens-004",
        tenantId: "tenant-abc",
        branchReservations: [1000000, 1000000, 1000000],
      }

      const result = await reserver.reserve(reservation)

      expect(result.ok).toBe(true)
      expect(result.budgetAfter).toBe(3000000)
    })

    it("is idempotent — same ensemble_id reuses existing reservation", async () => {
      const reservation: EnsembleReservation = {
        ensembleId: "ens-005",
        tenantId: "tenant-abc",
        branchReservations: [1000, 2000],
      }

      const result1 = await reserver.reserve(reservation)
      expect(result1.ok).toBe(true)
      expect(result1.idempotent).toBe(false)

      // Second call with same ensembleId
      const result2 = await reserver.reserve(reservation)
      expect(result2.ok).toBe(true)
      expect(result2.idempotent).toBe(true)
    })

    it("sets 5-min TTL on reservation hash (crash recovery)", async () => {
      const reservation: EnsembleReservation = {
        ensembleId: "ens-006",
        tenantId: "tenant-abc",
        branchReservations: [1000],
      }

      await reserver.reserve(reservation)

      const reservedKey = "finn:hounfour:ensemble:ens-006:reserved"
      expect(mockClient.getTTL(reservedKey)).toBe(300)
    })

    it("throws when Redis not connected", async () => {
      const disconnectedBackend = {
        ...mockBackend,
        isConnected: () => false,
      } as unknown as RedisStateBackend

      const reserver2 = new EnsembleBudgetReserver({ redis: disconnectedBackend })

      await expect(
        reserver2.reserve({
          ensembleId: "ens-007",
          tenantId: "tenant-abc",
          branchReservations: [1000],
        }),
      ).rejects.toThrow("Redis not connected")
    })
  })

  describe("commitBranch()", () => {
    it("releases unused reservation for a branch", async () => {
      // Reserve 3 branches: 1000, 2000, 3000
      await reserver.reserve({
        ensembleId: "ens-010",
        tenantId: "tenant-abc",
        branchReservations: [1000, 2000, 3000],
      })

      // Commit branch 0 with actual cost of 800 (refund 200)
      const result = await reserver.commitBranch("ens-010", "tenant-abc", 0, 800)

      expect(result.reserved).toBe(1000)
      expect(result.actual).toBe(800)
      expect(result.refund).toBe(200)
    })

    it("decrements budget by refund amount", async () => {
      await reserver.reserve({
        ensembleId: "ens-011",
        tenantId: "tenant-abc",
        branchReservations: [5000, 5000],
      })

      const spentKey = "finn:hounfour:budget:tenant-abc:spent_micro"
      const beforeCommit = parseInt(mockClient.getStoreValue(spentKey) ?? "0", 10)
      expect(beforeCommit).toBe(10000)

      // Branch 0: reserved 5000, used 2000 → refund 3000
      await reserver.commitBranch("ens-011", "tenant-abc", 0, 2000)

      const afterCommit = parseInt(mockClient.getStoreValue(spentKey) ?? "0", 10)
      expect(afterCommit).toBe(7000) // 10000 - 3000 refund
    })

    it("handles exact usage (no refund)", async () => {
      await reserver.reserve({
        ensembleId: "ens-012",
        tenantId: "tenant-abc",
        branchReservations: [1000],
      })

      const result = await reserver.commitBranch("ens-012", "tenant-abc", 0, 1000)

      expect(result.refund).toBe(0)
      expect(result.actual).toBe(1000)
    })

    it("cleans up hash when all branches committed", async () => {
      await reserver.reserve({
        ensembleId: "ens-013",
        tenantId: "tenant-abc",
        branchReservations: [1000, 2000],
      })

      const reservedKey = "finn:hounfour:ensemble:ens-013:reserved"

      await reserver.commitBranch("ens-013", "tenant-abc", 0, 500)
      expect(mockClient.getHashSize(reservedKey)).toBe(1) // branch 1 still reserved

      await reserver.commitBranch("ens-013", "tenant-abc", 1, 1500)
      expect(mockClient.getHashSize(reservedKey)).toBe(0) // all committed, hash deleted
    })
  })

  describe("hasReservation()", () => {
    it("returns branch count for active reservation", async () => {
      await reserver.reserve({
        ensembleId: "ens-020",
        tenantId: "tenant-abc",
        branchReservations: [1000, 2000, 3000],
      })

      const count = await reserver.hasReservation("ens-020")
      expect(count).toBe(3)
    })

    it("returns 0 for unknown ensemble", async () => {
      const count = await reserver.hasReservation("ens-nonexistent")
      expect(count).toBe(0)
    })
  })

  describe("releaseAll()", () => {
    it("releases all remaining reservation on error", async () => {
      await reserver.reserve({
        ensembleId: "ens-030",
        tenantId: "tenant-abc",
        branchReservations: [1000, 2000, 3000],
      })

      const spentKey = "finn:hounfour:budget:tenant-abc:spent_micro"
      expect(parseInt(mockClient.getStoreValue(spentKey) ?? "0", 10)).toBe(6000)

      // Commit branch 0, then release the rest
      await reserver.commitBranch("ens-030", "tenant-abc", 0, 500)
      const refund = await reserver.releaseAll("ens-030", "tenant-abc")

      // Branches 1 (2000) + 2 (3000) = 5000 total remaining reservation
      expect(refund).toBe(5000)
    })

    it("returns 0 for already-committed ensemble", async () => {
      await reserver.reserve({
        ensembleId: "ens-031",
        tenantId: "tenant-abc",
        branchReservations: [1000],
      })

      await reserver.commitBranch("ens-031", "tenant-abc", 0, 800)
      const refund = await reserver.releaseAll("ens-031", "tenant-abc")

      expect(refund).toBe(0)
    })
  })
})
