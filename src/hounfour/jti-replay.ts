// src/hounfour/jti-replay.ts — JTI Replay Protection (SDD §3.1, T-A.2, F6b)
// Prevents reuse of JWT jti claims. TTL derived from JWT exp claim with clock skew.
// In-memory guard with periodic sweep + max size eviction.
// Redis-backed guard for multi-instance deployments.

import type { RedisStateBackend } from "./redis/client.js"

// --- Constants ---

const CLOCK_SKEW_SEC = 60          // Tolerance for clock drift between services
const MIN_TTL_SEC = 30             // Floor — even short-lived tokens get replay protection
const MAX_TTL_SEC = 7200           // Ceiling — cap memory usage for long-lived tokens
const CLEANUP_INTERVAL_MS = 60_000 // Sweep expired entries every 60s
const DEFAULT_MAX_SIZE = 100_000   // Maximum JTI entries before oldest-first eviction

// --- TTL Derivation ---

/**
 * Derive replay protection TTL from JWT exp claim.
 * Security-critical — must cover the full token lifetime plus clock skew.
 *
 * ttlSec = clamp(exp - now + CLOCK_SKEW_SEC, MIN_TTL_SEC, MAX_TTL_SEC)
 */
export function deriveJtiTtl(expUnixSec: number, nowUnixSec?: number): number {
  const now = nowUnixSec ?? Math.floor(Date.now() / 1000)
  const raw = expUnixSec - now + CLOCK_SKEW_SEC
  return Math.max(MIN_TTL_SEC, Math.min(MAX_TTL_SEC, raw))
}

// --- Interface ---

export interface JtiReplayGuard {
  /** Check if jti is a replay. Returns true if the jti was already seen. */
  checkAndStore(jti: string, ttlSeconds: number): Promise<boolean>
  /** Cleanup for graceful shutdown */
  dispose(): void
}

// --- In-Memory Guard ---

interface JtiEntry {
  expiresAt: number   // Date.now() + ttl*1000
  insertedAt: number  // Date.now() at insertion (for oldest-first eviction)
}

/**
 * In-memory jti replay guard with periodic sweep and max size eviction.
 * Periodic sweep replaces per-entry setTimeout to reduce timer overhead.
 */
export class InMemoryJtiReplayGuard implements JtiReplayGuard {
  private seen = new Map<string, JtiEntry>()
  private maxSize: number
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(maxSize?: number) {
    this.maxSize = maxSize ?? DEFAULT_MAX_SIZE

    // Start periodic cleanup
    this.cleanupTimer = setInterval(() => this.sweep(), CLEANUP_INTERVAL_MS)
    if (this.cleanupTimer.unref) this.cleanupTimer.unref()
  }

  async checkAndStore(jti: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now()
    const existing = this.seen.get(jti)

    if (existing) {
      if (existing.expiresAt > now) {
        return true // Still within TTL — replay detected
      }
      // Expired — remove and allow reuse
      this.seen.delete(jti)
    }

    // Enforce max size with oldest-first eviction
    if (this.seen.size >= this.maxSize) {
      this.evictOldest()
    }

    this.seen.set(jti, {
      expiresAt: now + ttlSeconds * 1000,
      insertedAt: now,
    })

    return false // Fresh JTI
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.seen.clear()
  }

  /** Visible for testing */
  get size(): number {
    return this.seen.size
  }

  private sweep(): void {
    const now = Date.now()
    for (const [jti, entry] of this.seen) {
      if (entry.expiresAt <= now) {
        this.seen.delete(jti)
      }
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null
    let oldestTime = Infinity

    for (const [jti, entry] of this.seen) {
      if (entry.insertedAt < oldestTime) {
        oldestTime = entry.insertedAt
        oldestKey = jti
      }
    }

    if (oldestKey) {
      this.seen.delete(oldestKey)
    }
  }
}

// --- Redis Guard ---

/**
 * Redis-backed jti replay guard.
 * Uses SET NX with EX TTL — atomic check-and-store.
 * Falls back to fail-closed when Redis unavailable (reject as replay).
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

  dispose(): void {
    // Redis handles TTL-based cleanup automatically
  }
}

// --- Factory ---

/**
 * Create a JTI replay guard. Uses Redis if backend available and connected,
 * in-memory fallback otherwise.
 */
export function createJtiReplayGuard(
  redis?: RedisStateBackend,
  maxSize?: number,
): JtiReplayGuard {
  if (redis && redis.isConnected()) {
    return new RedisJtiReplayGuard(redis)
  }
  return new InMemoryJtiReplayGuard(maxSize)
}
