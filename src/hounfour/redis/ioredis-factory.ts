// src/hounfour/redis/ioredis-factory.ts — ioredis adapter (SDD §4.6.1, T-2.12)
//
// Bridges the RedisClientFactory port interface with the actual ioredis library.
// Dynamically imports ioredis so the rest of the Redis code compiles without it.

import type { RedisConfig, RedisClientFactory, RedisCommandClient, RedisSubscriberClient } from "./client.js"

/**
 * Create a RedisClientFactory backed by ioredis.
 *
 * Uses dynamic import so the module compiles even when ioredis
 * is not installed (graceful degradation for dev environments).
 */
export async function createIoredisFactory(): Promise<RedisClientFactory> {
  // @ts-expect-error — ioredis types resolved at runtime; not a compile-time dependency
  const Redis = (await import("ioredis")).default as new (url: string, opts: Record<string, unknown>) => any

  return {
    createCommandClient(config: RedisConfig) {
      const client = new Redis(config.url, {
        connectTimeout: config.connectTimeoutMs,
        commandTimeout: config.commandTimeoutMs,
        maxRetriesPerRequest: config.maxRetriesPerRequest,
        enableOfflineQueue: config.enableOfflineQueue,
        lazyConnect: true,
      })

      // ioredis connect() is lazy — trigger it
      client.connect().catch(() => {})

      return client as unknown as RedisCommandClient & { on(event: string, handler: (...args: any[]) => void): void }
    },

    createSubscriberClient(config: RedisConfig) {
      const sub = new Redis(config.url, {
        connectTimeout: config.connectTimeoutMs,
        maxRetriesPerRequest: config.maxRetriesPerRequest,
        enableOfflineQueue: config.enableOfflineQueue,
        lazyConnect: true,
      })

      sub.connect().catch(() => {})

      return sub as unknown as RedisSubscriberClient
    },
  }
}
