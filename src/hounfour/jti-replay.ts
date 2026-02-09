// src/hounfour/jti-replay.ts — WS JWT Replay Protection (SDD §3.1, T-A.2)
// Prevents reuse of JWT jti claims for WebSocket upgrade requests.
// Uses Redis SET with TTL when available, falls back to in-memory Map.

import type { RedisStateBackend } from "./redis/client.js"

export interface JtiReplayGuard {
  /** Check if jti is a replay. Returns true if the jti was already seen. */
  checkAndStore(jti: string, ttlSeconds: number): Promise<boolean>
}

/**
 * Redis-backed jti replay guard.
 * Uses SET NX with TTL — atomic check-and-store.
 */
export class RedisJtiReplayGuard implements JtiReplayGuard {
  constructor(private redis: RedisStateBackend) {}

  async checkAndStore(jti: string, ttlSeconds: number): Promise<boolean> {
    if (!this.redis.isConnected()) {
      // Fail-closed: treat as replay when Redis unavailable
      return true
    }

    const key = this.redis.key("jti", jti)
    // SET NX returns "OK" if set (new jti), null if already exists (replay)
    const result = await this.redis.getClient().set(key, "1", "EX", ttlSeconds, "NX")
    return result === null // true = replay (already existed)
  }
}

/**
 * In-memory jti replay guard (fallback when Redis unavailable).
 * Uses Map with setTimeout cleanup.
 */
export class InMemoryJtiReplayGuard implements JtiReplayGuard {
  private seen = new Map<string, ReturnType<typeof setTimeout>>()

  async checkAndStore(jti: string, ttlSeconds: number): Promise<boolean> {
    if (this.seen.has(jti)) {
      return true // replay
    }

    const timer = setTimeout(() => {
      this.seen.delete(jti)
    }, ttlSeconds * 1000)
    if (timer.unref) timer.unref()

    this.seen.set(jti, timer)
    return false // new jti
  }

  /** Cleanup for graceful shutdown */
  destroy(): void {
    for (const timer of this.seen.values()) {
      clearTimeout(timer)
    }
    this.seen.clear()
  }

  get size(): number {
    return this.seen.size
  }
}
