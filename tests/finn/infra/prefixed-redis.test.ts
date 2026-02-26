// tests/finn/infra/prefixed-redis.test.ts — PrefixedRedisClient Tests (T-1.3, cycle-036)

import { describe, it, expect, vi } from "vitest"
import { createPrefixedRedisClient } from "../../../src/hounfour/infra/prefixed-redis.js"
import type { RedisCommandClient } from "../../../src/hounfour/redis/client.js"

function createMockRedis(): RedisCommandClient & { select: ReturnType<typeof vi.fn>; lastGetKey?: string; lastSetKey?: string; lastMgetKeys?: string[] } {
  const mock = {
    lastGetKey: undefined as string | undefined,
    lastSetKey: undefined as string | undefined,
    lastMgetKeys: undefined as string[] | undefined,
    select: vi.fn(),
    async get(key: string) { mock.lastGetKey = key; return null },
    async set(key: string, _value: string) { mock.lastSetKey = key; return "OK" as string | null },
    async del(...keys: string[]) { return keys.length },
    async incrby(key: string, _inc: number) { return 1 },
    async incrbyfloat() { return "0" },
    async expire() { return 1 },
    async exists() { return 0 },
    async ping() { return "PONG" },
    async eval() { return null },
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
    const prefixed = createPrefixedRedisClient(mock, "armitage:", 0)
    await prefixed.get("foo")
    expect(mock.lastGetKey).toBe("armitage:foo")
  })

  it("prepends prefix to set() key", async () => {
    const mock = createMockRedis()
    const prefixed = createPrefixedRedisClient(mock, "armitage:", 0)
    await prefixed.set("bar", "value")
    expect(mock.lastSetKey).toBe("armitage:bar")
  })

  it("prepends prefix to hgetall() key", async () => {
    const mock = createMockRedis()
    let capturedKey = ""
    mock.hgetall = async (key: string) => { capturedKey = key; return {} }
    const prefixed = createPrefixedRedisClient(mock, "test:", 0)
    await prefixed.hgetall("mykey")
    expect(capturedKey).toBe("test:mykey")
  })

  it("throws on prefix shorter than 2 chars", () => {
    const mock = createMockRedis()
    expect(() => createPrefixedRedisClient(mock, "x", 0)).toThrow("Redis prefix must be >= 2 chars")
  })

  it("throws on empty prefix", () => {
    const mock = createMockRedis()
    expect(() => createPrefixedRedisClient(mock, "", 0)).toThrow("Redis prefix must be >= 2 chars")
  })

  it("calls select(dbIndex) on construction", () => {
    const mock = createMockRedis()
    createPrefixedRedisClient(mock, "prefix:", 3)
    expect(mock.select).toHaveBeenCalledWith(3)
  })

  it("passes through non-key-bearing methods unchanged", async () => {
    const mock = createMockRedis()
    const prefixed = createPrefixedRedisClient(mock, "pfx:", 0)
    const pong = await prefixed.ping()
    expect(pong).toBe("PONG")
  })
})
