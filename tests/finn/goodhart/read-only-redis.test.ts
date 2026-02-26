// tests/finn/goodhart/read-only-redis.test.ts — ReadOnlyRedisClient Tests (T-1.2, T-7.1, T-7.11)

import { describe, it, expect } from "vitest"
import { createReadOnlyRedisClient } from "../../../src/hounfour/goodhart/read-only-redis.js"
import type { RedisCommandClient } from "../../../src/hounfour/redis/client.js"

function createMockRedis(): RedisCommandClient & Record<string, unknown> {
  return {
    async get(key: string) { return `val:${key}` },
    async set() { return "OK" },
    async del() { return 0 },
    async incrby() { return 1 },
    async incrbyfloat() { return "0" },
    async expire() { return 1 },
    async exists(..._keys: string[]) { return 1 },
    async ping() { return "PONG" },
    async eval() { return null },
    async hgetall(key: string) { return { a: "1", key } },
    async hincrby() { return 0 },
    async zadd() { return 0 },
    async zpopmin() { return [] },
    async zremrangebyscore() { return 0 },
    async zcard() { return 0 },
    async publish() { return 0 },
    async quit() { return "OK" },
    // Extra methods for testing
    async mget(..._keys: string[]) { return ["v1", "v2"] },
    async hget(_key: string, _field: string) { return "field-val" },
    async ttl(_key: string) { return 300 },
    async type(_key: string) { return "string" },
    // Bypass vectors
    multi() { return {} },
    pipeline() { return {} },
    async sendCommand() { return null },
    async evalsha() { return null },
  } as any
}

// --- Read method pass-through (AC1: all 7 read methods) ---

describe("read method pass-through", () => {
  it("get() passes through", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    expect(await ro.get("foo")).toBe("val:foo")
  })

  it("mget() passes through", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis()) as any
    expect(await ro.mget("k1", "k2")).toEqual(["v1", "v2"])
  })

  it("hget() passes through", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis()) as any
    expect(await ro.hget("hash", "field")).toBe("field-val")
  })

  it("hgetall() passes through", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    const result = await ro.hgetall("foo")
    expect(result).toHaveProperty("a", "1")
  })

  it("exists() passes through", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    expect(await ro.exists("foo")).toBe(1)
  })

  it("ttl() passes through", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis()) as any
    expect(await ro.ttl("foo")).toBe(300)
  })

  it("type() passes through", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis()) as any
    expect(await ro.type("foo")).toBe("string")
  })
})

// --- Bypass vector blocking (AC2: all 5 bypass vectors) ---

describe("bypass vector blocking", () => {
  it("multi() returns rejected Promise (T-7.1)", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis()) as any
    await expect(ro.multi()).rejects.toThrow("Redis bypass vector blocked in shadow mode (attempted: multi)")
  })

  it("pipeline() returns rejected Promise", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis()) as any
    await expect(ro.pipeline()).rejects.toThrow("Redis bypass vector blocked in shadow mode (attempted: pipeline)")
  })

  it("sendCommand() returns rejected Promise", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis()) as any
    await expect(ro.sendCommand()).rejects.toThrow("Redis bypass vector blocked in shadow mode (attempted: sendCommand)")
  })

  it("eval() returns rejected Promise", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    await expect(ro.eval("return 1", 0)).rejects.toThrow("Redis bypass vector blocked in shadow mode (attempted: eval)")
  })

  it("evalsha() returns rejected Promise", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis()) as any
    await expect(ro.evalsha("sha", 0)).rejects.toThrow("Redis bypass vector blocked in shadow mode (attempted: evalsha)")
  })
})

// --- Mutating method blocking (AC3) ---

describe("mutating method blocking", () => {
  it("set() returns rejected Promise (T-7.1)", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    await expect(ro.set("foo", "bar")).rejects.toThrow("Redis writes blocked in shadow mode (attempted: set)")
  })

  it("del() returns rejected Promise", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    await expect(ro.del("foo")).rejects.toThrow("Redis writes blocked in shadow mode (attempted: del)")
  })

  it("incrby() returns rejected Promise", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    await expect(ro.incrby("foo", 1)).rejects.toThrow("Redis writes blocked in shadow mode (attempted: incrby)")
  })

  it("incrbyfloat() returns rejected Promise", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    await expect(ro.incrbyfloat("foo", 0.1)).rejects.toThrow("Redis writes blocked in shadow mode (attempted: incrbyfloat)")
  })

  it("expire() returns rejected Promise", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    await expect(ro.expire("foo", 60)).rejects.toThrow("Redis writes blocked in shadow mode (attempted: expire)")
  })

  it("hincrby() returns rejected Promise", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    await expect(ro.hincrby("h", "f", 1)).rejects.toThrow("Redis writes blocked in shadow mode (attempted: hincrby)")
  })

  it("zadd() returns rejected Promise", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    await expect(ro.zadd("z", 1, "m")).rejects.toThrow("Redis writes blocked in shadow mode (attempted: zadd)")
  })

  it("publish() returns rejected Promise", async () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    await expect(ro.publish("ch", "msg")).rejects.toThrow("Redis writes blocked in shadow mode (attempted: publish)")
  })
})

// --- Symbol property pass-through (AC4) ---

describe("Symbol property pass-through", () => {
  it("Symbol.toPrimitive passes through without throwing", () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    expect(() => (ro as any)[Symbol.toPrimitive]).not.toThrow()
  })

  it("Symbol.iterator passes through without throwing", () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    expect(() => (ro as any)[Symbol.iterator]).not.toThrow()
  })

  it("Symbol.toStringTag passes through without throwing", () => {
    const ro = createReadOnlyRedisClient(createMockRedis())
    expect(() => (ro as any)[Symbol.toStringTag]).not.toThrow()
  })

  it("custom Symbol returns target value", () => {
    const testSymbol = Symbol("test")
    const mock = createMockRedis() as any
    mock[testSymbol] = "symbol-value"
    const ro = createReadOnlyRedisClient(mock) as any
    expect(ro[testSymbol]).toBe("symbol-value")
  })
})

// --- Non-function property pass-through ---

describe("non-function property pass-through", () => {
  it("non-function properties pass through unchanged", () => {
    const mock = createMockRedis()
    mock.someProperty = 42
    const ro = createReadOnlyRedisClient(mock) as any
    expect(ro.someProperty).toBe(42)
  })

  it("undefined properties return undefined", () => {
    const ro = createReadOnlyRedisClient(createMockRedis()) as any
    expect(ro.nonExistentProp).toBeUndefined()
  })
})
