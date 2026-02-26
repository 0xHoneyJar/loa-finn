// src/hounfour/infra/prefixed-redis.ts — Prefixed Redis Client (SDD §4.1.2, cycle-036 T-1.3)
//
// Runtime key prefix enforcement via Proxy. All key-bearing commands prepend
// the configured prefix. Startup assertion rejects empty/short prefix.
// DB selection via async factory (T-6.5: awaited before returning client).
// eval/evalsha blocked to prevent prefix bypass (T-6.1).

import type { RedisCommandClient } from "../redis/client.js"

// Commands where the first argument is a single key
const SINGLE_KEY_COMMANDS = new Set([
  "get", "set", "incr", "decr", "incrby", "decrby",
  "hget", "hset", "hgetall", "hdel", "hexists", "hkeys", "hvals", "hlen",
  "exists", "ttl", "pttl", "type", "expire", "pexpire",
  "lpush", "rpush", "lpop", "rpop", "llen", "lrange",
  "sadd", "srem", "smembers", "sismember", "scard",
  "zadd", "zrem", "zrange", "zrangebyscore", "zscore", "zcard",
  "getset", "setnx", "setex", "psetex", "append", "strlen",
])

// Commands where ALL arguments are keys (T-6.8: del is multi-key only)
const MULTI_KEY_COMMANDS = new Set(["mget", "del"])

// Commands that bypass prefix enforcement and must be blocked (T-6.1)
const BLOCKED_COMMANDS = new Set(["eval", "evalsha"])

/**
 * Async factory: creates a Proxy-wrapped Redis client with prefix enforcement.
 * Awaits SELECT before returning to guarantee DB isolation (T-6.5).
 *
 * @param redis - Underlying Redis client
 * @param prefix - Key prefix (e.g., "armitage:") — must be >= 2 chars
 * @param dbIndex - Redis logical DB to SELECT (awaited before client returned)
 */
export async function createPrefixedRedisClient(
  redis: RedisCommandClient,
  prefix: string,
  dbIndex: number,
): Promise<RedisCommandClient> {
  if (!prefix || prefix.length < 2) {
    throw new Error(`Redis prefix must be >= 2 chars, got: "${prefix}"`)
  }

  // T-6.5: Await SELECT to guarantee DB is switched before any commands
  if (typeof (redis as any).select === "function") {
    await (redis as any).select(dbIndex)
  }

  return new Proxy(redis, {
    get(target, prop: string | symbol) {
      // Symbols (e.g. Symbol.toPrimitive, Symbol.iterator) pass through unchanged
      if (typeof prop === "symbol") {
        return (target as any)[prop]
      }

      const value = (target as Record<string, unknown>)[prop]

      if (typeof value !== "function") {
        return value
      }

      // T-6.1: Block eval/evalsha — Lua scripts bypass prefix enforcement
      if (BLOCKED_COMMANDS.has(prop)) {
        return () => {
          throw new Error(
            `PrefixedRedisClient: "${prop}" is blocked — Lua scripts bypass key prefix enforcement. Use individual prefixed commands instead.`,
          )
        }
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

      // Multi-key commands: prefix all string arguments (T-6.8: del prefixes all keys)
      if (MULTI_KEY_COMMANDS.has(prop)) {
        return (...args: unknown[]) => {
          for (let i = 0; i < args.length; i++) {
            if (typeof args[i] === "string") {
              args[i] = `${prefix}${args[i]}`
            }
          }
          return (value as Function).apply(target, args)
        }
      }

      // All other methods pass through unchanged
      return value.bind(target)
    },
  }) as RedisCommandClient
}
