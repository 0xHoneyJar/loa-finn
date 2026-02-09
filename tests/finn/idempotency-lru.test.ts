// tests/finn/idempotency-lru.test.ts — LRU Eviction tests (T-A.9)

import { describe, it, expect } from "vitest"
import { IdempotencyCache } from "../../src/hounfour/idempotency.js"
import type { ToolResult } from "../../src/hounfour/idempotency.js"

const OK: ToolResult = { output: "ok", is_error: false }

describe("IdempotencyCache LRU (T-A.9)", () => {
  it("evicts oldest entry when maxEntries reached", async () => {
    const cache = new IdempotencyCache(60_000, 3) // max 3 entries

    await cache.set("t", "tool", { i: 1 }, OK)
    await cache.set("t", "tool", { i: 2 }, OK)
    await cache.set("t", "tool", { i: 3 }, OK)
    expect(cache.size).toBe(3)

    // Adding 4th should evict the oldest (i:1)
    await cache.set("t", "tool", { i: 4 }, OK)
    expect(cache.size).toBe(3)
    expect(await cache.get("t", "tool", { i: 1 })).toBeNull()
    expect(await cache.get("t", "tool", { i: 2 })).not.toBeNull()
    expect(await cache.get("t", "tool", { i: 4 })).not.toBeNull()

    cache.destroy()
  })

  it("accessing an entry moves it to front (prevents eviction)", async () => {
    const cache = new IdempotencyCache(60_000, 3)

    await cache.set("t", "tool", { i: 1 }, OK)
    await cache.set("t", "tool", { i: 2 }, OK)
    await cache.set("t", "tool", { i: 3 }, OK)

    // Access i:1 to make it most recently used
    await cache.get("t", "tool", { i: 1 })

    // Insert i:4 — should evict i:2 (now the oldest unused)
    await cache.set("t", "tool", { i: 4 }, OK)
    expect(cache.size).toBe(3)
    expect(await cache.get("t", "tool", { i: 1 })).not.toBeNull() // accessed, so kept
    expect(await cache.get("t", "tool", { i: 2 })).toBeNull()      // evicted (was LRU)
    expect(await cache.get("t", "tool", { i: 3 })).not.toBeNull()
    expect(await cache.get("t", "tool", { i: 4 })).not.toBeNull()

    cache.destroy()
  })

  it("updating an entry moves it to front", async () => {
    const cache = new IdempotencyCache(60_000, 3)

    await cache.set("t", "tool", { i: 1 }, OK)
    await cache.set("t", "tool", { i: 2 }, OK)
    await cache.set("t", "tool", { i: 3 }, OK)

    // Update i:1 with new result
    const updated: ToolResult = { output: "updated", is_error: false }
    await cache.set("t", "tool", { i: 1 }, updated)

    // Insert i:4 — should evict i:2 (now oldest)
    await cache.set("t", "tool", { i: 4 }, OK)
    expect(await cache.get("t", "tool", { i: 1 })).toEqual(updated)
    expect(await cache.get("t", "tool", { i: 2 })).toBeNull()

    cache.destroy()
  })

  it("insert 10,001 entries → verify size = 10,000, oldest evicted", async () => {
    const cache = new IdempotencyCache(60_000, 10_000) // default max

    for (let i = 0; i < 10_001; i++) {
      await cache.set("t", "tool", { i }, OK)
    }

    expect(cache.size).toBe(10_000)
    // First entry (i=0) should be evicted
    expect(await cache.get("t", "tool", { i: 0 })).toBeNull()
    // Last entry should exist
    expect(await cache.get("t", "tool", { i: 10_000 })).not.toBeNull()

    cache.destroy()
  })

  it("preserves TTL behavior with LRU", async () => {
    const cache = new IdempotencyCache(50, 100) // 50ms TTL, 100 max

    await cache.set("t", "tool", { x: 1 }, OK)
    expect(await cache.get("t", "tool", { x: 1 })).not.toBeNull()

    await new Promise(r => setTimeout(r, 80))

    expect(await cache.get("t", "tool", { x: 1 })).toBeNull()

    cache.destroy()
  })

  it("destroy clears both map and linked list", async () => {
    const cache = new IdempotencyCache(60_000, 10)

    for (let i = 0; i < 5; i++) {
      await cache.set("t", "tool", { i }, OK)
    }

    expect(cache.size).toBe(5)
    cache.destroy()
    expect(cache.size).toBe(0)
  })

  it("single entry cache works correctly", async () => {
    const cache = new IdempotencyCache(60_000, 1)

    await cache.set("t", "tool", { i: 1 }, OK)
    expect(cache.size).toBe(1)
    expect(await cache.get("t", "tool", { i: 1 })).toEqual(OK)

    // Second insert evicts first
    await cache.set("t", "tool", { i: 2 }, OK)
    expect(cache.size).toBe(1)
    expect(await cache.get("t", "tool", { i: 1 })).toBeNull()
    expect(await cache.get("t", "tool", { i: 2 })).toEqual(OK)

    cache.destroy()
  })
})
