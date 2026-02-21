// src/nft/signal-cache.ts — Redis Signal Cache (Sprint 5 T5.2)
//
// Caches SignalSnapshot data in Redis with 24h TTL.
// Key format: finn:signal:{tokenId}
// On cache miss: calls OnChainReader → caches result → returns.
// ownerOf is always re-verified on cache miss.

import type { RedisCommandClient } from "../hounfour/redis/client.js"
import type { OnChainReader } from "./on-chain-reader.js"
import type { SignalSnapshot } from "./signal-types.js"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SignalCacheConfig {
  redis: RedisCommandClient
  onChainReader: OnChainReader
  /** Cache TTL in seconds (default: 86400 = 24h) */
  ttlSeconds?: number
  /** Key prefix (default: "finn:signal:") */
  keyPrefix?: string
}

// ---------------------------------------------------------------------------
// Cached entry shape stored in Redis
// ---------------------------------------------------------------------------

interface CachedSignal {
  snapshot: SignalSnapshot
  owner: string
  cachedAt: number
}

// ---------------------------------------------------------------------------
// SignalCache
// ---------------------------------------------------------------------------

export class SignalCache {
  private readonly redis: RedisCommandClient
  private readonly reader: OnChainReader
  private readonly ttlSeconds: number
  private readonly keyPrefix: string

  constructor(config: SignalCacheConfig) {
    this.redis = config.redis
    this.reader = config.onChainReader
    this.ttlSeconds = config.ttlSeconds ?? 86_400
    this.keyPrefix = config.keyPrefix ?? "finn:signal:"
  }

  /**
   * Get signal snapshot for a token.
   * Returns cached value if available, otherwise reads on-chain and caches.
   */
  async getSignals(tokenId: string): Promise<{ snapshot: SignalSnapshot; owner: string; fromCache: boolean }> {
    const key = this.cacheKey(tokenId)

    // Try cache first
    const cached = await this.redis.get(key)
    if (cached) {
      try {
        const entry = JSON.parse(cached) as CachedSignal
        return { snapshot: entry.snapshot, owner: entry.owner, fromCache: true }
      } catch {
        // Corrupted cache entry — delete and fall through to on-chain read
        await this.redis.del(key)
      }
    }

    // Cache miss: read on-chain
    const { snapshot, owner } = await this.reader.readSignals(tokenId)

    // Cache the result
    const entry: CachedSignal = { snapshot, owner, cachedAt: Date.now() }
    await this.redis.set(key, JSON.stringify(entry), "EX", this.ttlSeconds)

    return { snapshot, owner, fromCache: false }
  }

  /**
   * Refresh owner verification without full signal re-read.
   * Used when ownership needs to be re-confirmed (e.g., before billing).
   */
  async refreshOwner(tokenId: string): Promise<string> {
    const owner = await this.reader.readOwner(tokenId)

    // Update owner in cached entry if it exists
    const key = this.cacheKey(tokenId)
    const cached = await this.redis.get(key)
    if (cached) {
      try {
        const entry = JSON.parse(cached) as CachedSignal
        entry.owner = owner
        await this.redis.set(key, JSON.stringify(entry), "EX", this.ttlSeconds)
      } catch {
        // Corrupted — just delete it
        await this.redis.del(key)
      }
    }

    return owner
  }

  /**
   * Invalidate cached signals for a token.
   */
  async invalidate(tokenId: string): Promise<void> {
    await this.redis.del(this.cacheKey(tokenId))
  }

  /**
   * Check if a token has cached signals.
   */
  async hasCached(tokenId: string): Promise<boolean> {
    const result = await this.redis.exists(this.cacheKey(tokenId))
    return result > 0
  }

  private cacheKey(tokenId: string): string {
    return `${this.keyPrefix}${tokenId}`
  }
}
