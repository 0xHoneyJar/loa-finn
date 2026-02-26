// src/hounfour/goodhart/read-only-redis.ts — Read-Only Redis Proxy (SDD §3.3, cycle-036 T-1.2)
//
// Proxy-based wrapper enforcing read-only access to Redis in shadow mode.
// Allows: get, mget, hget, hgetall, exists, ttl, type
// Blocks: all mutating methods + bypass vectors (multi, pipeline, sendCommand, eval, evalsha)

import type { RedisCommandClient } from "../redis/client.js"

const READ_METHODS = new Set(["get", "mget", "hget", "hgetall", "exists", "ttl", "type"])

const BYPASS_VECTORS = new Set(["multi", "pipeline", "sendCommand", "eval", "evalsha"])

/**
 * Create a Proxy-wrapped Redis client that only permits read operations.
 * Mutating methods throw with a descriptive error message.
 * Bypass vectors (multi, pipeline, sendCommand, eval, evalsha) are explicitly blocked.
 */
export function createReadOnlyRedisClient(redis: RedisCommandClient): RedisCommandClient {
  return new Proxy(redis, {
    get(target, prop: string | symbol) {
      // Symbols (e.g. Symbol.toPrimitive, Symbol.iterator) pass through unchanged
      if (typeof prop === "symbol") {
        return (target as any)[prop]
      }

      // Allow read methods to pass through
      if (READ_METHODS.has(prop)) {
        const method = (target as Record<string, unknown>)[prop]
        if (typeof method === "function") {
          return method.bind(target)
        }
        return method
      }

      // Block bypass vectors with rejected Promise (T-7.1: async-compatible)
      if (BYPASS_VECTORS.has(prop)) {
        return () => Promise.reject(new Error(`Redis bypass vector blocked in shadow mode (attempted: ${prop})`))
      }

      // Block all other functions (mutating methods) with rejected Promise (T-7.1)
      const value = (target as Record<string, unknown>)[prop]
      if (typeof value === "function") {
        return () => Promise.reject(new Error(`Redis writes blocked in shadow mode (attempted: ${prop})`))
      }

      // Non-function properties pass through unchanged
      return value
    },
  }) as RedisCommandClient
}
