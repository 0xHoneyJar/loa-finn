// src/hounfour/runtime-config.ts — RuntimeConfig (SDD §3.1, cycle-035 T-1.1)
//
// Redis GET per-request for routing mode. Env var fallback when Redis unreachable.
// Key: finn:config:reputation_routing → "disabled" | "shadow" | "enabled"
// Invalid/missing → "shadow" default (safe cold-start).

import type { RedisCommandClient } from "./redis/client.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoutingMode = "disabled" | "shadow" | "enabled"

const VALID_MODES: ReadonlySet<string> = new Set(["disabled", "shadow", "enabled"])

export const REDIS_CONFIG_KEY = "finn:config:reputation_routing"
const ENV_VAR = "FINN_REPUTATION_ROUTING"
const DEFAULT_MODE: RoutingMode = "shadow"

// ---------------------------------------------------------------------------
// RuntimeConfig
// ---------------------------------------------------------------------------

export class RuntimeConfig {
  private readonly redis: RedisCommandClient | null
  private lastKnownMode: RoutingMode = DEFAULT_MODE
  private lastRedisReadMs = 0

  constructor(redis: RedisCommandClient | null) {
    this.redis = redis
  }

  /**
   * Get current routing mode. Redis GET on every call (~0.1ms LAN).
   * Falls back to env var, then to last known value, then to "shadow".
   */
  async getMode(): Promise<RoutingMode> {
    // 1. Try Redis
    if (this.redis) {
      try {
        const start = Date.now()
        const val = await this.redis.get(REDIS_CONFIG_KEY)
        this.lastRedisReadMs = Date.now() - start

        if (val !== null && VALID_MODES.has(val)) {
          this.lastKnownMode = val as RoutingMode
          return val as RoutingMode
        }
        // Key missing or invalid → fall through to env var
      } catch {
        // Redis unreachable → fall through to env var
      }
    }

    // 2. Env var fallback
    const envVal = process.env[ENV_VAR]
    if (envVal && VALID_MODES.has(envVal)) {
      this.lastKnownMode = envVal as RoutingMode
      return envVal as RoutingMode
    }

    // 3. Last known value or default
    return this.lastKnownMode
  }

  /**
   * Set routing mode via Redis. Throws if Redis unavailable.
   * Used by admin API for mode changes.
   */
  async setMode(mode: RoutingMode): Promise<void> {
    if (!VALID_MODES.has(mode)) {
      throw new Error(`Invalid routing mode: ${mode}`)
    }
    if (!this.redis) {
      throw new Error("Cannot set mode: Redis not available")
    }
    await this.redis.set(REDIS_CONFIG_KEY, mode)
    this.lastKnownMode = mode
  }

  /** Whether Redis is being used (for health reporting). */
  get hasRedis(): boolean {
    return this.redis !== null
  }

  /** Last Redis read latency in ms (0 if never read). */
  get lastLatencyMs(): number {
    return this.lastRedisReadMs
  }
}
