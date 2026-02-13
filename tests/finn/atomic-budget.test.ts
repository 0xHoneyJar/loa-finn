// tests/finn/atomic-budget.test.ts — Redis Atomic Budget Commit tests (Task 2.2b)
import { describe, it, expect, beforeEach, vi } from "vitest"
import { AtomicBudgetRecorder } from "../../src/hounfour/redis/atomic-budget.js"
import { LedgerV2 } from "../../src/hounfour/ledger-v2.js"
import type { LedgerEntryV2 } from "../../src/hounfour/types.js"
import type { RedisStateBackend } from "../../src/hounfour/redis/client.js"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// --- Test Helpers ---

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "atomic-budget-test-"))
}

function makeEntry(overrides: Partial<LedgerEntryV2> = {}): LedgerEntryV2 {
  return {
    schema_version: 2,
    timestamp: new Date().toISOString(),
    trace_id: randomUUID(),
    agent: "test-agent",
    provider: "openai",
    model: "gpt-4o",
    project_id: "proj-1",
    phase_id: "phase-1",
    sprint_id: "sprint-1",
    tenant_id: "tenant-abc",
    prompt_tokens: 100,
    completion_tokens: 50,
    reasoning_tokens: 0,
    input_cost_micro: "300",
    output_cost_micro: "600",
    reasoning_cost_micro: "0",
    total_cost_micro: "900",
    price_table_version: 1,
    billing_method: "provider_reported",
    latency_ms: 500,
    ...overrides,
  }
}

/**
 * In-memory Redis mock that supports eval() for Lua script execution.
 * Simulates the atomic behavior of the Lua script.
 *
 * BB-PR63-F002: Atomicity limitation — this mock executes Lua script logic
 * as sequential JavaScript, which is inherently atomic in single-threaded Node.
 * Real Redis Lua scripts are atomic across concurrent clients at the server level.
 * This mock cannot reproduce race conditions that would appear with multiple
 * Redis clients executing EVAL concurrently. For true atomicity testing,
 * use a real Redis instance with parallel client connections.
 */
class MockRedisClient {
  private store = new Map<string, string>()
  private ttls = new Map<string, number>()

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<string | null> {
    // Parse SET args (EX seconds, NX)
    let nx = false
    let ex: number | null = null
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "NX") nx = true
      if (args[i] === "EX" && i + 1 < args.length) ex = Number(args[i + 1])
    }

    if (nx && this.store.has(key)) return null

    this.store.set(key, value)
    if (ex) this.ttls.set(key, ex)
    return "OK"
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0
    for (const key of keys) {
      if (this.store.delete(key)) deleted++
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
    const current = parseFloat(this.store.get(key) ?? "0")
    const newVal = current + increment
    this.store.set(key, String(newVal))
    return String(newVal)
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (this.store.has(key)) {
      this.ttls.set(key, seconds)
      return 1
    }
    return 0
  }

  async exists(...keys: string[]): Promise<number> {
    return keys.filter(k => this.store.has(k)).length
  }

  async ping(): Promise<string> { return "PONG" }

  async hgetall(key: string): Promise<Record<string, string>> { return {} }
  async hincrby(key: string, field: string, increment: number): Promise<number> { return 0 }
  async zadd(key: string, score: number, member: string): Promise<number> { return 0 }
  async zpopmin(key: string, count?: number): Promise<string[]> { return [] }
  async zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number> { return 0 }
  async zcard(key: string): Promise<number> { return 0 }
  async publish(channel: string, message: string): Promise<number> { return 0 }
  async quit(): Promise<string> { return "OK" }

  /**
   * Simulate Redis EVAL for our Lua script.
   * Implements the exact semantics of ATOMIC_RECORD_COST_LUA.
   */
  async eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    const keys = args.slice(0, numkeys) as string[]
    const argv = args.slice(numkeys) as string[]

    const budgetKey = keys[0]
    const idemKey = keys[1]
    const headroomKey = keys[2]
    const costMicro = argv[0]
    const idemValue = argv[1]
    const reconStatus = argv[2]

    // Check idempotency FIRST
    if (idemValue !== "") {
      const existing = this.store.get(idemKey)
      if (existing !== undefined) {
        // Duplicate — return cached cost
        return [1, existing]
      }
    }

    // New request — INCRBY
    const cost = parseInt(costMicro, 10)
    const current = parseInt(this.store.get(budgetKey) ?? "0", 10)
    const newBudget = current + cost
    this.store.set(budgetKey, String(newBudget))

    // Store idempotency marker
    if (idemValue !== "") {
      this.store.set(idemKey, costMicro)
      this.ttls.set(idemKey, 86400)
    }

    // FAIL_OPEN headroom
    if (reconStatus === "FAIL_OPEN") {
      const headroom = parseInt(this.store.get(headroomKey) ?? "0", 10)
      this.store.set(headroomKey, String(headroom - cost))
    }

    return [0, String(newBudget)]
  }

  // --- Test inspection helpers ---
  _getStore(): Map<string, string> { return this.store }
  _getTtls(): Map<string, number> { return this.ttls }
}

function makeMockRedis(): { backend: RedisStateBackend; client: MockRedisClient } {
  const client = new MockRedisClient()
  const backend = {
    isConnected: () => true,
    getClient: () => client,
    key: (component: string, ...parts: string[]) =>
      `finn:hounfour:${component}:${parts.join(":")}`,
  } as unknown as RedisStateBackend
  return { backend, client }
}

function makeDisconnectedRedis(): RedisStateBackend {
  return {
    isConnected: () => false,
    getClient: () => { throw new Error("Not connected") },
    key: (component: string, ...parts: string[]) =>
      `finn:hounfour:${component}:${parts.join(":")}`,
  } as unknown as RedisStateBackend
}

// --- Tests ---

describe("AtomicBudgetRecorder", () => {
  let tempDir: string
  let ledger: LedgerV2
  let redis: ReturnType<typeof makeMockRedis>
  let recorder: AtomicBudgetRecorder

  beforeEach(() => {
    tempDir = makeTempDir()
    ledger = new LedgerV2({ baseDir: tempDir, fsync: false })
    redis = makeMockRedis()
    recorder = new AtomicBudgetRecorder({ redis: redis.backend, ledger })
  })

  // --- Normal recording flow ---

  describe("recordCost", () => {
    it("records cost to JSONL and Redis atomically", async () => {
      const entry = makeEntry({ total_cost_micro: "1500" })
      const result = await recorder.recordCost(
        "tenant-abc", entry, "idem-key-1",
      )

      expect(result.isDuplicate).toBe(false)
      expect(result.costMicro).toBe(1500)
      expect(result.journalWritten).toBe(true)
      expect(result.redisCommitted).toBe(true)
      expect(result.budgetTotalMicro).toBe(1500)
    })

    it("accumulates budget across multiple recordings", async () => {
      const entry1 = makeEntry({ total_cost_micro: "1000", trace_id: "t1" })
      const entry2 = makeEntry({ total_cost_micro: "2000", trace_id: "t2" })

      await recorder.recordCost("tenant-abc", entry1, "idem-1")
      const result2 = await recorder.recordCost("tenant-abc", entry2, "idem-2")

      expect(result2.budgetTotalMicro).toBe(3000)
      expect(result2.isDuplicate).toBe(false)
    })

    it("writes entry to JSONL ledger", async () => {
      const entry = makeEntry({ total_cost_micro: "500" })
      await recorder.recordCost("tenant-abc", entry, "idem-key-2")

      const count = await ledger.countEntries("tenant-abc")
      expect(count).toBe(1)
    })

    it("rejects non-integer cost values", async () => {
      const entry = makeEntry({ total_cost_micro: "12.5" })
      await expect(
        recorder.recordCost("tenant-abc", entry, "idem-key")
      ).rejects.toThrow("BUDGET_INVALID")
    })

    it("rejects negative cost values", async () => {
      const entry = makeEntry({ total_cost_micro: "-100" })
      await expect(
        recorder.recordCost("tenant-abc", entry, "idem-key")
      ).rejects.toThrow("BUDGET_INVALID")
    })

    it("handles zero cost (free requests)", async () => {
      const entry = makeEntry({ total_cost_micro: "0" })
      const result = await recorder.recordCost("tenant-abc", entry, "idem-zero")

      expect(result.isDuplicate).toBe(false)
      expect(result.costMicro).toBe(0)
      expect(result.budgetTotalMicro).toBe(0)
    })
  })

  // --- Idempotency ---

  describe("idempotency", () => {
    it("detects duplicate with same idempotency key", async () => {
      const entry1 = makeEntry({ total_cost_micro: "1000", trace_id: "t1" })
      const entry2 = makeEntry({ total_cost_micro: "1000", trace_id: "t2" })

      const result1 = await recorder.recordCost("tenant-abc", entry1, "same-key")
      expect(result1.isDuplicate).toBe(false)

      const result2 = await recorder.recordCost("tenant-abc", entry2, "same-key")
      expect(result2.isDuplicate).toBe(true)
      expect(result2.costMicro).toBe(1000) // Cached cost returned
    })

    it("does not double-charge on retry with same idempotency key", async () => {
      const entry = makeEntry({ total_cost_micro: "5000" })

      await recorder.recordCost("tenant-abc", entry, "retry-key")

      // Retry N times with same idempotency key
      for (let i = 0; i < 5; i++) {
        const retryEntry = makeEntry({ total_cost_micro: "5000", trace_id: `retry-${i}` })
        const result = await recorder.recordCost("tenant-abc", retryEntry, "retry-key")
        expect(result.isDuplicate).toBe(true)
      }

      // Budget should be 5000, not 30000
      const total = await recorder.getBudgetTotal("tenant-abc")
      expect(total).toBe(5000)
    })

    it("treats different idempotency keys as separate requests", async () => {
      const entry1 = makeEntry({ total_cost_micro: "1000" })
      const entry2 = makeEntry({ total_cost_micro: "2000" })

      await recorder.recordCost("tenant-abc", entry1, "key-A")
      const result = await recorder.recordCost("tenant-abc", entry2, "key-B")

      expect(result.isDuplicate).toBe(false)
      expect(result.budgetTotalMicro).toBe(3000)
    })

    it("checkIdempotency returns cached cost for existing key", async () => {
      const entry = makeEntry({ total_cost_micro: "7500" })
      await recorder.recordCost("tenant-abc", entry, "check-key")

      const cached = await recorder.checkIdempotency("check-key")
      expect(cached).toBe(7500)
    })

    it("checkIdempotency returns null for unknown key", async () => {
      const cached = await recorder.checkIdempotency("unknown-key")
      expect(cached).toBeNull()
    })
  })

  // --- Write-ahead protocol (crash scenarios) ---

  describe("write-ahead protocol", () => {
    it("(a) crash after JSONL, before Redis → JSONL exists for recompute", async () => {
      // Simulate Redis failure after JSONL write
      const failingRedis = makeMockRedis()
      const failClient = failingRedis.client
      // Make eval throw (simulating Redis crash)
      failClient.eval = async () => { throw new Error("Redis crashed") }

      const failRecorder = new AtomicBudgetRecorder({
        redis: failingRedis.backend, ledger,
      })

      const entry = makeEntry({ total_cost_micro: "3000" })
      const result = await failRecorder.recordCost("tenant-abc", entry, "crash-a")

      // JSONL written but Redis failed
      expect(result.journalWritten).toBe(true)
      expect(result.redisCommitted).toBe(false)

      // JSONL has the entry for recovery
      const count = await ledger.countEntries("tenant-abc")
      expect(count).toBe(1)

      // Recovery recomputes from JSONL → sets Redis
      const stats = await recorder.recoverFromJournal("tenant-abc")
      expect(stats.recomputedTotalMicro).toBe(3000n)
      expect(stats.redisUpdated).toBe(true)

      // Redis now has correct total
      const total = await recorder.getBudgetTotal("tenant-abc")
      expect(total).toBe(3000)
    })

    it("(b) crash after Redis, before JSONL → idempotency prevents double-charge", async () => {
      // Record normally (both JSONL + Redis succeed)
      const entry1 = makeEntry({ total_cost_micro: "2000" })
      await recorder.recordCost("tenant-abc", entry1, "crash-b-key")

      // Now retry same request (simulating post-crash retry)
      // Even with a different trace_id, same idempotency key → duplicate
      const entry2 = makeEntry({ total_cost_micro: "2000", trace_id: "retry-trace" })
      const result = await recorder.recordCost("tenant-abc", entry2, "crash-b-key")

      expect(result.isDuplicate).toBe(true)

      // Budget should be exactly 2000 (not 4000)
      const total = await recorder.getBudgetTotal("tenant-abc")
      expect(total).toBe(2000)
    })

    it("(c) N retries with different trace_ids → exactly one charge", async () => {
      const idemKey = "multi-retry-key"

      for (let i = 0; i < 10; i++) {
        const entry = makeEntry({
          total_cost_micro: "1000",
          trace_id: `trace-${i}`,
        })
        await recorder.recordCost("tenant-abc", entry, idemKey)
      }

      // Exactly one charge of 1000
      const total = await recorder.getBudgetTotal("tenant-abc")
      expect(total).toBe(1000)
    })

    it("(d) retry with changed body → different idempotency key → new charge", async () => {
      const entry1 = makeEntry({ total_cost_micro: "1000" })
      const result1 = await recorder.recordCost("tenant-abc", entry1, "body-hash-A")

      const entry2 = makeEntry({ total_cost_micro: "1500" })
      const result2 = await recorder.recordCost("tenant-abc", entry2, "body-hash-B")

      expect(result1.isDuplicate).toBe(false)
      expect(result2.isDuplicate).toBe(false)

      // Both charged
      const total = await recorder.getBudgetTotal("tenant-abc")
      expect(total).toBe(2500)
    })

    it("JSONL failure prevents Redis write (no orphaned Redis entries)", async () => {
      // Create a ledger that throws on append
      const brokenLedger = {
        append: async () => { throw new Error("Disk full") },
        recover: async () => ({ entriesRecovered: 0, linesTruncated: 0, corruptedEntries: 0 }),
        recompute: async () => ({ totalEntries: 0, duplicatesRemoved: 0, totalCostMicro: 0n }),
      } as unknown as LedgerV2

      const brokenRecorder = new AtomicBudgetRecorder({
        redis: redis.backend, ledger: brokenLedger,
      })

      const entry = makeEntry({ total_cost_micro: "5000" })
      await expect(
        brokenRecorder.recordCost("tenant-abc", entry, "orphan-key")
      ).rejects.toThrow("BUDGET_JOURNAL_FAILED")

      // Redis should NOT have the entry
      const total = await recorder.getBudgetTotal("tenant-abc")
      expect(total).toBe(0)
    })
  })

  // --- Redis unavailable ---

  describe("Redis unavailable", () => {
    it("records to JSONL when Redis is disconnected", async () => {
      const disconnectedRedis = makeDisconnectedRedis()
      const offlineRecorder = new AtomicBudgetRecorder({
        redis: disconnectedRedis, ledger,
      })

      const entry = makeEntry({ total_cost_micro: "2500" })
      const result = await offlineRecorder.recordCost("tenant-abc", entry, "offline-key")

      expect(result.journalWritten).toBe(true)
      expect(result.redisCommitted).toBe(false)
      expect(result.isDuplicate).toBe(false)
    })

    it("checkIdempotency returns null when Redis is disconnected", async () => {
      const disconnectedRedis = makeDisconnectedRedis()
      const offlineRecorder = new AtomicBudgetRecorder({
        redis: disconnectedRedis, ledger,
      })

      const cached = await offlineRecorder.checkIdempotency("any-key")
      expect(cached).toBeNull()
    })

    it("getBudgetTotal returns null when Redis is disconnected", async () => {
      const disconnectedRedis = makeDisconnectedRedis()
      const offlineRecorder = new AtomicBudgetRecorder({
        redis: disconnectedRedis, ledger,
      })

      const total = await offlineRecorder.getBudgetTotal("tenant-abc")
      expect(total).toBeNull()
    })
  })

  // --- FAIL_OPEN headroom ---

  describe("FAIL_OPEN headroom decrement", () => {
    it("decrements headroom when reconStatus is FAIL_OPEN", async () => {
      // Set initial headroom
      const headroomKey = "finn:hounfour:budget:tenant-abc:headroom_micro"
      await redis.client.set(headroomKey, "100000")

      const entry = makeEntry({ total_cost_micro: "5000" })
      await recorder.recordCost("tenant-abc", entry, "headroom-key", "FAIL_OPEN")

      const headroom = await redis.client.get(headroomKey)
      expect(headroom).toBe("95000") // 100000 - 5000
    })

    it("does not decrement headroom when SYNCED", async () => {
      const headroomKey = "finn:hounfour:budget:tenant-abc:headroom_micro"
      await redis.client.set(headroomKey, "100000")

      const entry = makeEntry({ total_cost_micro: "5000" })
      await recorder.recordCost("tenant-abc", entry, "synced-key", "SYNCED")

      const headroom = await redis.client.get(headroomKey)
      expect(headroom).toBe("100000") // Unchanged
    })

    it("monotonic headroom decrement across multiple FAIL_OPEN recordings", async () => {
      const headroomKey = "finn:hounfour:budget:tenant-abc:headroom_micro"
      await redis.client.set(headroomKey, "50000")

      for (let i = 0; i < 5; i++) {
        const entry = makeEntry({ total_cost_micro: "3000", trace_id: `fo-${i}` })
        await recorder.recordCost("tenant-abc", entry, `fo-key-${i}`, "FAIL_OPEN")
      }

      const headroom = await redis.client.get(headroomKey)
      expect(headroom).toBe("35000") // 50000 - (5 * 3000)
    })

    it("headroom goes negative when exhausted (signals FAIL_CLOSED transition)", async () => {
      const headroomKey = "finn:hounfour:budget:tenant-abc:headroom_micro"
      await redis.client.set(headroomKey, "1000")

      const entry = makeEntry({ total_cost_micro: "5000" })
      await recorder.recordCost("tenant-abc", entry, "exhaust-key", "FAIL_OPEN")

      const headroom = await redis.client.get(headroomKey)
      expect(parseInt(headroom!, 10)).toBe(-4000) // 1000 - 5000 = -4000
    })
  })

  // --- Recovery ---

  describe("recoverFromJournal", () => {
    it("recomputes Redis from JSONL entries", async () => {
      // Write entries directly to JSONL
      const entries = [
        makeEntry({ total_cost_micro: "1000", trace_id: "r1" }),
        makeEntry({ total_cost_micro: "2000", trace_id: "r2" }),
        makeEntry({ total_cost_micro: "3000", trace_id: "r3" }),
      ]
      for (const e of entries) {
        await ledger.append("tenant-abc", e)
      }

      // Redis has wrong value (simulating drift)
      const budgetKey = "finn:hounfour:budget:tenant-abc:spent_micro"
      await redis.client.set(budgetKey, "999")

      const stats = await recorder.recoverFromJournal("tenant-abc")

      expect(stats.uniqueEntries).toBe(3)
      expect(stats.recomputedTotalMicro).toBe(6000n)
      expect(stats.redisUpdated).toBe(true)

      // Redis should now have correct total
      const total = await recorder.getBudgetTotal("tenant-abc")
      expect(total).toBe(6000)
    })

    it("deduplicates by trace_id during recovery", async () => {
      // Write duplicate entries (same trace_id)
      const entry1 = makeEntry({ total_cost_micro: "1000", trace_id: "dup-trace" })
      const entry2 = makeEntry({ total_cost_micro: "1000", trace_id: "dup-trace" })
      const entry3 = makeEntry({ total_cost_micro: "2000", trace_id: "unique-trace" })

      await ledger.append("tenant-abc", entry1)
      await ledger.append("tenant-abc", entry2)
      await ledger.append("tenant-abc", entry3)

      const stats = await recorder.recoverFromJournal("tenant-abc")

      expect(stats.uniqueEntries).toBe(2)
      expect(stats.duplicatesFound).toBe(1)
      expect(stats.recomputedTotalMicro).toBe(3000n) // 1000 + 2000
    })

    it("handles empty tenant gracefully", async () => {
      const stats = await recorder.recoverFromJournal("empty-tenant")

      expect(stats.uniqueEntries).toBe(0)
      expect(stats.recomputedTotalMicro).toBe(0n)
    })

    it("recovery works when Redis is unavailable", async () => {
      await ledger.append("tenant-abc", makeEntry({ total_cost_micro: "5000" }))

      const offlineRecorder = new AtomicBudgetRecorder({
        redis: makeDisconnectedRedis(), ledger,
      })

      const stats = await offlineRecorder.recoverFromJournal("tenant-abc")

      expect(stats.uniqueEntries).toBe(1)
      expect(stats.recomputedTotalMicro).toBe(5000n)
      expect(stats.redisUpdated).toBe(false) // Can't update Redis
    })
  })

  // --- Multi-tenant isolation ---

  describe("multi-tenant isolation", () => {
    it("records costs independently per tenant", async () => {
      const entry1 = makeEntry({ total_cost_micro: "1000", tenant_id: "tenant-A" })
      const entry2 = makeEntry({ total_cost_micro: "2000", tenant_id: "tenant-B" })

      await recorder.recordCost("tenant-A", entry1, "key-A")
      await recorder.recordCost("tenant-B", entry2, "key-B")

      const totalA = await recorder.getBudgetTotal("tenant-A")
      const totalB = await recorder.getBudgetTotal("tenant-B")

      expect(totalA).toBe(1000)
      expect(totalB).toBe(2000)
    })

    it("idempotency keys are global (not per-tenant)", async () => {
      // Same idempotency key for different tenants — still detected
      // (because idempotency key includes tenant in derivation)
      // But in our API, the caller provides the full key
      const entry1 = makeEntry({ total_cost_micro: "1000" })
      const entry2 = makeEntry({ total_cost_micro: "2000" })

      const result1 = await recorder.recordCost("tenant-A", entry1, "shared-idem")
      const result2 = await recorder.recordCost("tenant-B", entry2, "shared-idem")

      // Second is duplicate (same idem key globally)
      expect(result1.isDuplicate).toBe(false)
      expect(result2.isDuplicate).toBe(true)
    })
  })

  // --- Edge cases ---

  describe("edge cases", () => {
    it("handles large cost values within integer range", async () => {
      // $999.999999 = 999999999 micro-USD (just under max request cost)
      const entry = makeEntry({ total_cost_micro: "999999999" })
      const result = await recorder.recordCost("tenant-abc", entry, "large-key")

      expect(result.costMicro).toBe(999999999)
      expect(result.budgetTotalMicro).toBe(999999999)
    })

    it("handles concurrent recordings to same tenant (sequential via ledger mutex)", async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        recorder.recordCost(
          "tenant-abc",
          makeEntry({ total_cost_micro: "100", trace_id: `conc-${i}` }),
          `conc-key-${i}`,
        )
      )

      const results = await Promise.all(promises)

      // All should succeed, none should be duplicates
      expect(results.every(r => !r.isDuplicate)).toBe(true)
      expect(results.every(r => r.journalWritten)).toBe(true)
      expect(results.every(r => r.redisCommitted)).toBe(true)

      // Total should be 10 * 100 = 1000
      const total = await recorder.getBudgetTotal("tenant-abc")
      expect(total).toBe(1000)
    })
  })
})
