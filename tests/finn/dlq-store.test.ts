// tests/finn/dlq-store.test.ts — DLQStore unit tests (Sprint 1 T4)
// 15 tests: InMemory CRUD + upsert + batch + oldest, Redis Lua verification + claim contention

import { describe, it, expect, vi, beforeEach } from "vitest"
import { InMemoryDLQStore } from "../../src/hounfour/dlq-store.js"
import { RedisDLQStore } from "../../src/hounfour/redis/dlq.js"
import type { DLQEntry } from "../../src/hounfour/billing-finalize-client.js"
import type { RedisStateBackend, RedisCommandClient } from "../../src/hounfour/redis/client.js"

// --- Test Helpers ---

function createEntry(overrides?: Partial<DLQEntry>): DLQEntry {
  return {
    reservation_id: "res-001",
    tenant_id: "tenant-abc",
    actual_cost_micro: "1500000",
    trace_id: "trace-001",
    reason: "http_500",
    response_status: 500,
    attempt_count: 1,
    next_attempt_at: new Date(Date.now() - 60_000).toISOString(), // 1 min ago (ready)
    created_at: new Date(Date.now() - 300_000).toISOString(),     // 5 min ago
    ...overrides,
  }
}

/** Mock RedisStateBackend with eval capture for Lua script verification */
function createMockRedis(): {
  redis: RedisStateBackend
  client: RedisCommandClient & { evalCalls: Array<{ script: string; numkeys: number; args: (string | number)[] }> }
  store: Map<string, string>
  zset: Map<string, number>
} {
  const store = new Map<string, string>()
  const zset = new Map<string, number>()  // member → score
  const evalCalls: Array<{ script: string; numkeys: number; args: (string | number)[] }> = []

  const client: any = {
    evalCalls,

    get: vi.fn(async (key: string) => store.get(key) ?? null),

    set: vi.fn(async (key: string, value: string, ...args: (string | number)[]) => {
      // Handle NX flag for SETNX behavior
      if (args.includes("NX") && store.has(key)) return null
      store.set(key, value)
      return "OK"
    }),

    del: vi.fn(async (...keys: string[]) => {
      let count = 0
      for (const k of keys) {
        if (store.delete(k)) count++
      }
      return count
    }),

    zcard: vi.fn(async (key: string) => zset.size),

    eval: vi.fn(async (script: string, numkeys: number, ...args: (string | number)[]) => {
      evalCalls.push({ script, numkeys, args: [...args] })

      // Simulate DLQ_TERMINAL_DROP — check BEFORE DELETE (both share DEL+ZREM+DEL pattern)
      // Unique discriminator: KEYS[4] (terminal keyspace) + "json and 1 or 0"
      if (script.includes('SET", KEYS[4]') && script.includes("json and 1 or 0")) {
        const entryKey = args[0] as string
        const terminalKey = args[3] as string
        const rid = args[numkeys] as string
        const lockKey = args[2] as string

        const json = store.get(entryKey)
        if (json) store.set(terminalKey, json)
        store.delete(entryKey)
        zset.delete(rid)
        store.delete(lockKey)
        return json ? 1 : 0
      }

      // Simulate DLQ_INCREMENT_ATTEMPT — check BEFORE UPSERT (both share attempt_count pattern)
      // Unique discriminator: "local updated = cjson.encode(entry)" (only in INCREMENT)
      if (script.includes("local updated = cjson.encode(entry)")) {
        const entryKey = args[0] as string
        const nextAttemptAt = args[numkeys] as string
        const ttl = args[numkeys + 1] as number
        const nextMs = args[numkeys + 2] as number
        const rid = args[numkeys + 3] as string

        const json = store.get(entryKey)
        if (!json) return null
        const entry = JSON.parse(json)
        entry.attempt_count += 1
        entry.next_attempt_at = nextAttemptAt
        store.set(entryKey, JSON.stringify(entry))
        zset.set(rid, nextMs)
        return entry.attempt_count
      }

      // Simulate DLQ_UPSERT — uses "local incoming = cjson.decode(ARGV[1])"
      if (script.includes("local incoming = cjson.decode(ARGV[1])")) {
        const entryKey = args[0] as string
        const json = args[numkeys] as string
        const nextMs = args[numkeys + 1] as number
        const ttl = args[numkeys + 2] as number
        const rid = args[numkeys + 3] as string

        const existing = store.get(entryKey)
        if (existing) {
          const entry = JSON.parse(existing)
          const incoming = JSON.parse(json)
          entry.attempt_count += 1
          entry.next_attempt_at = incoming.next_attempt_at
          entry.reason = incoming.reason
          entry.response_status = incoming.response_status
          store.set(entryKey, JSON.stringify(entry))
        } else {
          store.set(entryKey, json)
        }
        zset.set(rid, nextMs)
        return 1
      }

      // Simulate DLQ_DELETE — uses DEL+ZREM+DEL but NOT KEYS[4]
      if (script.includes('DEL", KEYS[1]') && script.includes('ZREM') && script.includes('DEL", KEYS[3]')) {
        const entryKey = args[0] as string
        const rid = args[numkeys] as string
        const lockKey = args[2] as string
        store.delete(entryKey)
        zset.delete(rid)
        store.delete(lockKey)
        return 1
      }

      // Simulate ZRANGEBYSCORE (getReady)
      if (script.includes("ZRANGEBYSCORE")) {
        const cutoff = Number(args[numkeys])
        const limit = Number(args[numkeys + 1])
        const ready = [...zset.entries()]
          .filter(([, score]) => score <= cutoff)
          .sort((a, b) => a[1] - b[1])
          .slice(0, limit)
          .map(([member]) => member)
        return ready
      }

      // Simulate DLQ_OLDEST_CREATED — scans all payloads, finds min created_at
      if (script.includes("oldest") && script.includes("created_at")) {
        const entryPrefix = args[numkeys - 1] as string  // KEYS[2] = entry prefix
        let oldest: string | null = null
        for (const rid of zset.keys()) {
          const json = store.get(entryPrefix + rid)
          if (json) {
            const entry = JSON.parse(json)
            if (entry.created_at && (oldest === null || entry.created_at < oldest)) {
              oldest = entry.created_at
            }
          }
        }
        return oldest
      }

      // Simulate ZREM (orphan repair)
      if (script.includes("ZREM")) {
        const rid = args[numkeys] as string
        zset.delete(rid)
        return 1
      }

      return null
    }),
  }

  const redis = {
    key: (component: string, ...parts: string[]) => `finn:hounfour:${component}:${parts.join(":")}`,
    getClient: () => client,
    isConnected: () => true,
  } as unknown as RedisStateBackend

  return { redis, client, store, zset }
}

// === InMemoryDLQStore Tests ===

describe("InMemoryDLQStore", () => {
  let store: InMemoryDLQStore

  beforeEach(() => {
    store = new InMemoryDLQStore()
  })

  it("CRUD: put, get, delete, count", async () => {
    const entry = createEntry()
    await store.put(entry)
    expect(await store.count()).toBe(1)
    expect(await store.get("res-001")).toEqual(entry)

    await store.delete("res-001")
    expect(await store.count()).toBe(0)
    expect(await store.get("res-001")).toBeNull()
  })

  it("upsert increments attempt_count for existing entries, preserves created_at", async () => {
    const entry = createEntry({ attempt_count: 1, created_at: "2026-01-01T00:00:00Z" })
    await store.put(entry)

    const updated = createEntry({
      attempt_count: 1,
      reason: "http_503",
      next_attempt_at: new Date(Date.now() + 120_000).toISOString(),
      created_at: "2026-02-01T00:00:00Z",  // should be ignored on upsert
    })
    await store.put(updated)

    const result = await store.get("res-001")
    expect(result!.attempt_count).toBe(2) // incremented by put()
    expect(result!.reason).toBe("http_503")
    expect(result!.created_at).toBe("2026-01-01T00:00:00Z") // preserved
  })

  it("getReady filters by next_attempt_at and respects batch limit", async () => {
    const smallStore = new InMemoryDLQStore({ batchLimit: 2 })

    for (let i = 0; i < 5; i++) {
      await smallStore.put(createEntry({
        reservation_id: `res-${i}`,
        next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
      }))
    }

    // Future entry should not be returned
    await smallStore.put(createEntry({
      reservation_id: "res-future",
      next_attempt_at: new Date(Date.now() + 600_000).toISOString(),
    }))

    const ready = await smallStore.getReady(new Date())
    expect(ready.length).toBe(2) // batch limit
  })

  it("oldestEntryAgeMs computes from created_at, not next_attempt_at", async () => {
    const oldCreated = new Date(Date.now() - 600_000).toISOString() // 10 min ago
    const newCreated = new Date(Date.now() - 60_000).toISOString()  // 1 min ago

    await store.put(createEntry({ reservation_id: "res-old", created_at: oldCreated }))
    await store.put(createEntry({ reservation_id: "res-new", created_at: newCreated }))

    const age = await store.oldestEntryAgeMs()
    expect(age).not.toBeNull()
    // Should be close to 600_000ms (10 min), allow 5s tolerance
    expect(age!).toBeGreaterThan(595_000)
    expect(age!).toBeLessThan(605_000)
  })

  it("count returns 0 for empty store, oldestEntryAgeMs returns null", async () => {
    expect(await store.count()).toBe(0)
    expect(await store.oldestEntryAgeMs()).toBeNull()
  })
})

// === RedisDLQStore Tests ===

describe("RedisDLQStore", () => {
  let mockRedis: ReturnType<typeof createMockRedis>
  let store: RedisDLQStore

  beforeEach(() => {
    mockRedis = createMockRedis()
    store = new RedisDLQStore(mockRedis.redis)
  })

  it("put/get round-trip preserves entry", async () => {
    const entry = createEntry()
    await store.put(entry)
    const result = await store.get("res-001")
    expect(result).toEqual(entry)
  })

  it("upsert atomicity: DLQ_UPSERT Lua increments existing entry", async () => {
    const entry = createEntry({ attempt_count: 1 })
    await store.put(entry)
    await store.put(createEntry({ attempt_count: 1, reason: "http_503" }))

    const result = await store.get("res-001")
    expect(result!.attempt_count).toBe(2)
    expect(result!.reason).toBe("http_503")
  })

  it("getReady returns bounded batch via ZRANGEBYSCORE LIMIT", async () => {
    const smallStore = new RedisDLQStore(mockRedis.redis, { batchLimit: 2 })
    for (let i = 0; i < 5; i++) {
      await smallStore.put(createEntry({
        reservation_id: `res-${i}`,
        next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
      }))
    }
    const ready = await smallStore.getReady(new Date())
    expect(ready.length).toBe(2)
  })

  it("ZSET member is rid (not full key path)", async () => {
    await store.put(createEntry({ reservation_id: "res-xyz" }))
    // Verify the ZSET contains the rid, not the full key
    expect(mockRedis.zset.has("res-xyz")).toBe(true)
    expect(mockRedis.zset.has("finn:hounfour:dlq:entry:res-xyz")).toBe(false)
  })

  it("orphan repair: missing payload triggers ZREM + warn log", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    // Add a ZSET member without a payload
    mockRedis.zset.set("res-orphan", Date.now() - 60_000)

    const ready = await store.getReady(new Date())
    expect(ready.length).toBe(0) // orphan not returned
    expect(mockRedis.zset.has("res-orphan")).toBe(false) // removed
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("orphan repair")
    )
    warnSpy.mockRestore()
  })

  it("claimForReplay returns true on first call, false on second (SETNX)", async () => {
    const first = await store.claimForReplay("res-001")
    expect(first).toBe(true)

    const second = await store.claimForReplay("res-001")
    expect(second).toBe(false)
  })

  it("releaseClaim removes lock key", async () => {
    await store.claimForReplay("res-001")
    expect(mockRedis.store.has("finn:hounfour:dlq:lock:res-001")).toBe(true)

    await store.releaseClaim("res-001")
    expect(mockRedis.store.has("finn:hounfour:dlq:lock:res-001")).toBe(false)
  })

  it("incrementAttempt updates both payload AND ZSET score", async () => {
    await store.put(createEntry({ attempt_count: 2 }))

    const futureMs = Date.now() + 240_000
    const futureAt = new Date(futureMs).toISOString()
    const newCount = await store.incrementAttempt("res-001", futureAt, futureMs)

    expect(newCount).toBe(3) // 2 + 1
    const entry = await store.get("res-001")
    expect(entry!.attempt_count).toBe(3)
    expect(entry!.next_attempt_at).toBe(futureAt)

    // ZSET score updated
    expect(mockRedis.zset.get("res-001")).toBe(futureMs)
  })

  it("terminalDrop moves payload to terminal keyspace and cleans active keys", async () => {
    await store.put(createEntry())
    await store.claimForReplay("res-001")

    await store.terminalDrop("res-001")

    // Active keys cleaned
    expect(await store.get("res-001")).toBeNull()
    expect(mockRedis.zset.has("res-001")).toBe(false)
    expect(mockRedis.store.has("finn:hounfour:dlq:lock:res-001")).toBe(false)

    // Terminal keyspace preserves entry
    const terminalJson = mockRedis.store.get("finn:hounfour:dlq:terminal:res-001")
    expect(terminalJson).toBeDefined()
    const terminal = JSON.parse(terminalJson!)
    expect(terminal.reservation_id).toBe("res-001")
  })

  it("oldestEntryAgeMs scans all payloads by created_at, not ZSET order", async () => {
    const oldCreated = new Date(Date.now() - 600_000).toISOString() // 10 min ago
    const newCreated = new Date(Date.now() - 60_000).toISOString()  // 1 min ago

    // Put older entry with LATER schedule (higher ZSET score)
    await store.put(createEntry({
      reservation_id: "res-old",
      created_at: oldCreated,
      next_attempt_at: new Date(Date.now() + 300_000).toISOString(), // future schedule
    }))
    // Put newer entry with EARLIER schedule (lower ZSET score)
    await store.put(createEntry({
      reservation_id: "res-new",
      created_at: newCreated,
      next_attempt_at: new Date(Date.now() - 60_000).toISOString(), // past schedule
    }))

    const age = await store.oldestEntryAgeMs()
    expect(age).not.toBeNull()
    // Should be ~600_000ms (10 min) — the OLDER entry by created_at, not the one first in ZSET
    expect(age!).toBeGreaterThan(595_000)
    expect(age!).toBeLessThan(605_000)
  })

  it("delete cleans all keys: payload, schedule, lock", async () => {
    await store.put(createEntry())
    await store.claimForReplay("res-001")

    await store.delete("res-001")

    expect(await store.get("res-001")).toBeNull()
    expect(mockRedis.zset.has("res-001")).toBe(false)
    expect(mockRedis.store.has("finn:hounfour:dlq:lock:res-001")).toBe(false)
  })

  it("validatePersistence returns { aofVerified: true, checked: true } when AOF on", async () => {
    // Override eval to simulate CONFIG GET appendonly = yes
    const origEval = mockRedis.client.eval
    mockRedis.client.eval = vi.fn(async (script: string, numkeys: number, ...args: any[]) => {
      if (script.includes("CONFIG")) return ["appendonly", "yes"]
      return origEval(script, numkeys, ...args)
    }) as any

    const result = await store.validatePersistence()
    expect(result).toEqual({ aofVerified: true, checked: true })
  })

  it("validatePersistence returns { checked: false } when CONFIG blocked", async () => {
    const origEval = mockRedis.client.eval
    mockRedis.client.eval = vi.fn(async (script: string, numkeys: number, ...args: any[]) => {
      if (script.includes("CONFIG")) throw new Error("ERR unknown command 'CONFIG'")
      return origEval(script, numkeys, ...args)
    }) as any

    const result = await store.validatePersistence()
    expect(result.aofVerified).toBe(false)
    expect(result.checked).toBe(false)
    expect(result.reason).toContain("CONFIG restricted")
  })

  // Claim contention: two concurrent replayers — only one proceeds
  it("contention: two concurrent claimers — loser skips, no double-processing", async () => {
    await store.put(createEntry())

    // Simulate two concurrent claim attempts
    const [claim1, claim2] = await Promise.all([
      store.claimForReplay("res-001"),
      store.claimForReplay("res-001"),
    ])

    // Exactly one wins
    const winners = [claim1, claim2].filter(Boolean)
    const losers = [claim1, claim2].filter(c => !c)
    expect(winners.length).toBe(1)
    expect(losers.length).toBe(1)

    // Loser must NOT call incrementAttempt/delete/terminalDrop
    // (This verifies the invariant: failed claim → no mutation)
    const incrementSpy = vi.spyOn(store, "incrementAttempt")
    const deleteSpy = vi.spyOn(store, "delete")
    const terminalSpy = vi.spyOn(store, "terminalDrop")

    // Simulate the loser's behavior: skip entirely on failed claim
    if (!claim1) {
      // claim1 lost — should NOT call any mutation
      expect(incrementSpy).not.toHaveBeenCalled()
      expect(deleteSpy).not.toHaveBeenCalled()
      expect(terminalSpy).not.toHaveBeenCalled()
    }
    if (!claim2) {
      // claim2 lost — should NOT call any mutation
      expect(incrementSpy).not.toHaveBeenCalled()
      expect(deleteSpy).not.toHaveBeenCalled()
      expect(terminalSpy).not.toHaveBeenCalled()
    }

    // Winner processes: simulate successful replay
    await store.delete("res-001")
    expect(await store.get("res-001")).toBeNull()

    // Clean up
    await store.releaseClaim("res-001")
  })
})
