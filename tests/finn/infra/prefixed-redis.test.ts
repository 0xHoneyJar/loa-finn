// tests/finn/infra/prefixed-redis.test.ts — PrefixedRedisClient Tests (T-1.3, cycle-036)

import { describe, it, expect, vi } from "vitest"
import { createPrefixedRedisClient } from "../../../src/hounfour/infra/prefixed-redis.js"
import type { RedisCommandClient } from "../../../src/hounfour/redis/client.js"

function createMockRedis(): RedisCommandClient & { select: ReturnType<typeof vi.fn>; lastGetKey?: string; lastSetKey?: string; lastDelKeys?: string[] } {
  const mock = {
    lastGetKey: undefined as string | undefined,
    lastSetKey: undefined as string | undefined,
    lastDelKeys: undefined as string[] | undefined,
    select: vi.fn().mockResolvedValue("OK"),
    async get(key: string) { mock.lastGetKey = key; return null },
    async set(key: string, _value: string) { mock.lastSetKey = key; return "OK" as string | null },
    async del(...keys: string[]) { mock.lastDelKeys = keys; return keys.length },
    async incrby(key: string, _inc: number) { return 1 },
    async incrbyfloat() { return "0" },
    async expire() { return 1 },
    async exists() { return 0 },
    async ping() { return "PONG" },
    async eval() { return null },
    async evalsha() { return null },
    async hgetall(key: string) { return {} as Record<string, string> },
    async hincrby() { return 0 },
    async zadd() { return 0 },
    async zpopmin() { return [] as string[] },
    async zremrangebyscore() { return 0 },
    async zcard() { return 0 },
    async publish() { return 0 },
    async quit() { return "OK" },
  }
  return mock
}

describe("createPrefixedRedisClient", () => {
  it("prepends prefix to get() key", async () => {
    const mock = createMockRedis()
    const prefixed = await createPrefixedRedisClient(mock, "armitage:", 0)
    await prefixed.get("foo")
    expect(mock.lastGetKey).toBe("armitage:foo")
  })

  it("prepends prefix to set() key", async () => {
    const mock = createMockRedis()
    const prefixed = await createPrefixedRedisClient(mock, "armitage:", 0)
    await prefixed.set("bar", "value")
    expect(mock.lastSetKey).toBe("armitage:bar")
  })

  it("prepends prefix to hgetall() key", async () => {
    const mock = createMockRedis()
    let capturedKey = ""
    mock.hgetall = async (key: string) => { capturedKey = key; return {} }
    const prefixed = await createPrefixedRedisClient(mock, "test:", 0)
    await prefixed.hgetall("mykey")
    expect(capturedKey).toBe("test:mykey")
  })

  it("throws on prefix shorter than 2 chars", async () => {
    const mock = createMockRedis()
    await expect(createPrefixedRedisClient(mock, "x", 0)).rejects.toThrow("Redis prefix must be >= 2 chars")
  })

  it("throws on empty prefix", async () => {
    const mock = createMockRedis()
    await expect(createPrefixedRedisClient(mock, "", 0)).rejects.toThrow("Redis prefix must be >= 2 chars")
  })

  it("awaits select(dbIndex) before returning client (T-6.5)", async () => {
    const mock = createMockRedis()
    const prefixed = await createPrefixedRedisClient(mock, "prefix:", 3)
    expect(mock.select).toHaveBeenCalledWith(3)
    // Verify select was awaited (mock resolved)
    expect(mock.select.mock.results[0].value).toBeInstanceOf(Promise)
    // Client is ready to use after factory returns
    await prefixed.get("key")
    expect(mock.lastGetKey).toBe("prefix:key")
  })

  it("passes through non-key-bearing methods unchanged", async () => {
    const mock = createMockRedis()
    const prefixed = await createPrefixedRedisClient(mock, "pfx:", 0)
    const pong = await prefixed.ping()
    expect(pong).toBe("PONG")
  })

  it("handles Symbol property access without throwing (T-4.5)", async () => {
    const mock = createMockRedis()
    const prefixed = await createPrefixedRedisClient(mock, "pfx:", 0)
    expect(() => (prefixed as any)[Symbol.toPrimitive]).not.toThrow()
    expect(() => (prefixed as any)[Symbol.iterator]).not.toThrow()
    expect(() => (prefixed as any)[Symbol.toStringTag]).not.toThrow()
  })

  it("Symbol property returns underlying target value", async () => {
    const mock = createMockRedis()
    const testSymbol = Symbol("test")
    ;(mock as any)[testSymbol] = "symbol-value"
    const prefixed = await createPrefixedRedisClient(mock, "pfx:", 0)
    expect((prefixed as any)[testSymbol]).toBe("symbol-value")
  })

  it("blocks eval() to prevent prefix bypass (T-6.1)", async () => {
    const mock = createMockRedis()
    const prefixed = await createPrefixedRedisClient(mock, "pfx:", 0)
    expect(() => (prefixed as any).eval("return 1", 1, "foo")).toThrow("blocked")
  })

  it("blocks evalsha() to prevent prefix bypass (T-6.1)", async () => {
    const mock = createMockRedis()
    const prefixed = await createPrefixedRedisClient(mock, "pfx:", 0)
    expect(() => (prefixed as any).evalsha("sha1hash", 1, "foo")).toThrow("blocked")
  })

  it("del() prefixes all keys, not just the first (T-6.8)", async () => {
    const mock = createMockRedis()
    const prefixed = await createPrefixedRedisClient(mock, "ns:", 0)
    await prefixed.del("a", "b", "c")
    expect(mock.lastDelKeys).toEqual(["ns:a", "ns:b", "ns:c"])
  })

  it("del() with single key still prefixed (T-6.8)", async () => {
    const mock = createMockRedis()
    const prefixed = await createPrefixedRedisClient(mock, "ns:", 0)
    await prefixed.del("only")
    expect(mock.lastDelKeys).toEqual(["ns:only"])
  })
})
