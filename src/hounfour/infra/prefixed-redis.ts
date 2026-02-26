// src/hounfour/infra/prefixed-redis.ts — Prefixed Redis Client (SDD §4.1.2, cycle-036 T-1.3)
//
// Runtime key prefix enforcement via Proxy. All key-bearing commands prepend
// the configured prefix. Startup assertion rejects empty/short prefix.
// DB selection via SELECT on construction.

import type { RedisCommandClient } from "../redis/client.js"

// Commands where the first argument is a single key
const SINGLE_KEY_COMMANDS = new Set([
  "get", "set", "del", "incr", "decr", "incrby", "decrby",
  "hget", "hset", "hgetall", "hdel", "hexists", "hkeys", "hvals", "hlen",
  "exists", "ttl", "pttl", "type", "expire", "pexpire",
  "lpush", "rpush", "lpop", "rpop", "llen", "lrange",
  "sadd", "srem", "smembers", "sismember", "scard",
  "zadd", "zrem", "zrange", "zrangebyscore", "zscore", "zcard",
  "getset", "setnx", "setex", "psetex", "append", "strlen",
])

// Commands where the first argument is an array of keys
const MULTI_KEY_COMMANDS = new Set(["mget", "del"])

/**
 * Create a Proxy-wrapped Redis client that prepends a prefix to all key-bearing commands.
 *
 * @param redis - Underlying Redis client
 * @param prefix - Key prefix (e.g., "armitage:") — must be >= 2 chars
 * @param dbIndex - Redis logical DB to SELECT on construction
 */
export function createPrefixedRedisClient(
  redis: RedisCommandClient,
  prefix: string,
  dbIndex: number,
): RedisCommandClient {
  if (!prefix || prefix.length < 2) {
    throw new Error(`Redis prefix must be >= 2 chars, got: "${prefix}"`)
  }

  // SELECT the correct DB on construction
  if (typeof (redis as any).select === "function") {
    ;(redis as any).select(dbIndex)
  }

  return new Proxy(redis, {
    get(target, prop: string) {
      const value = (target as Record<string, unknown>)[prop]

      if (typeof value !== "function") {
        return value
      }

      // Single-key commands: prefix the first argument
      if (SINGLE_KEY_COMMANDS.has(prop)) {
        return (...args: unknown[]) => {
          if (typeof args[0] === "string") {
            args[0] = `${prefix}${args[0]}`
          }
          return (value as Function).apply(target, args)
        }
      }

      // Multi-key commands: prefix each key in the array (or single key)
      if (MULTI_KEY_COMMANDS.has(prop)) {
        return (...args: unknown[]) => {
          if (Array.isArray(args[0])) {
            args[0] = (args[0] as string[]).map((k) => `${prefix}${k}`)
          } else if (typeof args[0] === "string") {
            args[0] = `${prefix}${args[0]}`
          }
          return (value as Function).apply(target, args)
        }
      }

      // All other methods pass through unchanged
      return value.bind(target)
    },
  }) as RedisCommandClient
}
