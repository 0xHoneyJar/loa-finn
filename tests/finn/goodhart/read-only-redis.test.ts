// tests/finn/goodhart/read-only-redis.test.ts — ReadOnlyRedisClient Tests (T-1.2, cycle-036)

import { describe, it, expect } from "vitest"
import { createReadOnlyRedisClient } from "../../../src/hounfour/goodhart/read-only-redis.js"
import type { RedisCommandClient } from "../../../src/hounfour/redis/client.js"

function createMockRedis(): RedisCommandClient {
  return {
    async get(key: string) { return `val:${key}` },
    async set() { return "OK" },
    async del() { return 0 },
    async incrby() { return 1 },
    async incrbyfloat() { return "0" },
    async expire() { return 1 },
    async exists() { return 1 },
    async ping() { return "PONG" },
    async eval() { return null },
    async hgetall() { return { a: "1" } },
    async hincrby() { return 0 },
    async zadd() { return 0 },
    async zpopmin() { return [] },
    async zremrangebyscore() { return 0 },
    async zcard() { return 0 },
    async publish() { return 0 },
    async quit() { return "OK" },
  }
}

describe("createReadOnlyRedisClient", () => {
  it("allows get() to pass through", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    const result = await ro.get("foo")
    expect(result).toBe("val:foo")
  })

  it("allows exists() to pass through", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    const result = await ro.exists("foo")
    expect(result).toBe(1)
  })

  it("allows hgetall() to pass through", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    const result = await ro.hgetall("foo")
    expect(result).toEqual({ a: "1" })
  })

  it("blocks set() with descriptive error", () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    expect(() => ro.set("foo", "bar")).toThrow("Redis writes blocked in shadow mode (attempted: set)")
  })

  it("blocks del() with descriptive error", () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    expect(() => ro.del("foo")).toThrow("Redis writes blocked in shadow mode (attempted: del)")
  })

  it("blocks incrby() with descriptive error", () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    expect(() => ro.incrby("foo", 1)).toThrow("Redis writes blocked in shadow mode (attempted: incrby)")
  })

  it("blocks eval() as bypass vector", () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    expect(() => ro.eval("return 1", 0)).toThrow("Redis bypass vector blocked in shadow mode (attempted: eval)")
  })

  it("passes through non-function properties unchanged", () => {
    const mock = createMockRedis() as any
    mock.someProperty = 42
    const ro = createReadOnlyRedisClient(mock) as any
    expect(ro.someProperty).toBe(42)
  })

  it("handles Symbol property access without throwing (T-4.5)", () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    // Symbol.toPrimitive is commonly accessed by runtime (e.g., console.log, JSON.stringify)
    expect(() => (ro as any)[Symbol.toPrimitive]).not.toThrow()
    expect(() => (ro as any)[Symbol.iterator]).not.toThrow()
    expect(() => (ro as any)[Symbol.toStringTag]).not.toThrow()
  })

  it("Symbol property returns underlying target value", () => {
    const mock = createMockRedis() as any
    const testSymbol = Symbol("test")
    mock[testSymbol] = "symbol-value"
    const ro = createReadOnlyRedisClient(mock) as any
    expect(ro[testSymbol]).toBe("symbol-value")
  })
})
