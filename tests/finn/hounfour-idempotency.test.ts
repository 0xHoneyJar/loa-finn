// tests/finn/hounfour-idempotency.test.ts — Hounfour idempotency cache tests (T-1.6)

import assert from "node:assert/strict"
import { IdempotencyCache, stableKey } from "../../src/hounfour/idempotency.js"
import type { ToolResult } from "../../src/hounfour/idempotency.js"

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

async function main() {
  console.log("Hounfour Idempotency Cache Tests (T-1.6)")
  console.log("=========================================")

  // --- stableKey ---

  await test("stableKey produces 32-char hex string", () => {
    const key = stableKey("tool_name", { a: 1 })
    assert.equal(key.length, 32)
    assert.match(key, /^[a-f0-9]{32}$/)
  })

  await test("stableKey is deterministic", () => {
    const k1 = stableKey("read_file", { path: "/tmp/test.txt" })
    const k2 = stableKey("read_file", { path: "/tmp/test.txt" })
    assert.equal(k1, k2)
  })

  await test("stableKey differs for different tool names", () => {
    const k1 = stableKey("tool_a", { x: 1 })
    const k2 = stableKey("tool_b", { x: 1 })
    assert.notEqual(k1, k2)
  })

  await test("stableKey differs for different arguments", () => {
    const k1 = stableKey("tool", { x: 1 })
    const k2 = stableKey("tool", { x: 2 })
    assert.notEqual(k1, k2)
  })

  await test("stableKey same for different key order (top-level)", () => {
    const k1 = stableKey("tool", { a: 1, b: 2 })
    const k2 = stableKey("tool", { b: 2, a: 1 })
    assert.equal(k1, k2)
  })

  await test("stableKey same for different key order (nested)", () => {
    const k1 = stableKey("tool", { outer: { z: 3, a: 1 }, list: [1, 2] })
    const k2 = stableKey("tool", { list: [1, 2], outer: { a: 1, z: 3 } })
    assert.equal(k1, k2)
  })

  await test("stableKey same for deeply nested different order", () => {
    const k1 = stableKey("tool", { a: { b: { c: 1, d: 2 }, e: 3 } })
    const k2 = stableKey("tool", { a: { e: 3, b: { d: 2, c: 1 } } })
    assert.equal(k1, k2)
  })

  await test("stableKey preserves array order", () => {
    const k1 = stableKey("tool", { items: [1, 2, 3] })
    const k2 = stableKey("tool", { items: [3, 2, 1] })
    assert.notEqual(k1, k2)
  })

  await test("stableKey handles null and primitive values", () => {
    const k1 = stableKey("tool", { a: null, b: true, c: "str", d: 42 })
    const k2 = stableKey("tool", { d: 42, c: "str", b: true, a: null })
    assert.equal(k1, k2)
  })

  // --- IdempotencyCache ---

  await test("cache miss returns null", async () => {
    const cache = new IdempotencyCache(60_000)
    const result = await cache.get("trace-1", "tool", { x: 1 })
    assert.equal(result, null)
    cache.destroy()
  })

  await test("cache hit returns stored result", async () => {
    const cache = new IdempotencyCache(60_000)
    const toolResult: ToolResult = { output: "result data", is_error: false }
    await cache.set("trace-1", "read_file", { path: "/tmp" }, toolResult)
    const result = await cache.get("trace-1", "read_file", { path: "/tmp" })
    assert.deepEqual(result, toolResult)
    cache.destroy()
  })

  await test("cache hit with different key order returns same result", async () => {
    const cache = new IdempotencyCache(60_000)
    const toolResult: ToolResult = { output: "ok", is_error: false }
    await cache.set("trace-1", "tool", { b: 2, a: 1 }, toolResult)
    const result = await cache.get("trace-1", "tool", { a: 1, b: 2 })
    assert.deepEqual(result, toolResult)
    cache.destroy()
  })

  await test("cache isolates by trace_id", async () => {
    const cache = new IdempotencyCache(60_000)
    const toolResult: ToolResult = { output: "trace1", is_error: false }
    await cache.set("trace-1", "tool", { x: 1 }, toolResult)

    const fromTrace1 = await cache.get("trace-1", "tool", { x: 1 })
    const fromTrace2 = await cache.get("trace-2", "tool", { x: 1 })
    assert.deepEqual(fromTrace1, toolResult)
    assert.equal(fromTrace2, null)
    cache.destroy()
  })

  await test("cache returns null for different arguments", async () => {
    const cache = new IdempotencyCache(60_000)
    await cache.set("trace-1", "tool", { x: 1 }, { output: "one", is_error: false })
    const result = await cache.get("trace-1", "tool", { x: 2 })
    assert.equal(result, null)
    cache.destroy()
  })

  await test("has() returns true for cached entry", async () => {
    const cache = new IdempotencyCache(60_000)
    await cache.set("trace-1", "tool", { x: 1 }, { output: "ok", is_error: false })
    assert.equal(await cache.has("trace-1", "tool", { x: 1 }), true)
    assert.equal(await cache.has("trace-1", "tool", { x: 2 }), false)
    cache.destroy()
  })

  await test("TTL eviction — expired entry returns null", async () => {
    const cache = new IdempotencyCache(50) // 50ms TTL
    await cache.set("trace-1", "tool", { x: 1 }, { output: "ok", is_error: false })

    const immediate = await cache.get("trace-1", "tool", { x: 1 })
    assert.deepEqual(immediate, { output: "ok", is_error: false })

    await new Promise(r => setTimeout(r, 80))

    const expired = await cache.get("trace-1", "tool", { x: 1 })
    assert.equal(expired, null)
    cache.destroy()
  })

  await test("size tracks entries correctly", async () => {
    const cache = new IdempotencyCache(60_000)
    assert.equal(cache.size, 0)
    await cache.set("t1", "tool", { a: 1 }, { output: "1", is_error: false })
    assert.equal(cache.size, 1)
    await cache.set("t1", "tool", { a: 2 }, { output: "2", is_error: false })
    assert.equal(cache.size, 2)
    await cache.set("t1", "tool", { a: 1 }, { output: "1b", is_error: false })
    assert.equal(cache.size, 2)
    cache.destroy()
  })

  await test("destroy clears all entries", async () => {
    const cache = new IdempotencyCache(60_000)
    await cache.set("t1", "tool", { a: 1 }, { output: "1", is_error: false })
    await cache.set("t1", "tool", { a: 2 }, { output: "2", is_error: false })
    assert.equal(cache.size, 2)
    cache.destroy()
    assert.equal(cache.size, 0)
  })

  await test("caches error results too", async () => {
    const cache = new IdempotencyCache(60_000)
    const errResult: ToolResult = { output: "permission denied", is_error: true }
    await cache.set("t1", "write_file", { path: "/root/x" }, errResult)
    const result = await cache.get("t1", "write_file", { path: "/root/x" })
    assert.deepEqual(result, errResult)
    assert.equal(result!.is_error, true)
    cache.destroy()
  })

  console.log("\nDone.")
}

main()
