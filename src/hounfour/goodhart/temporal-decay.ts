// src/hounfour/goodhart/temporal-decay.ts — EMA Temporal Decay Engine (SDD §4.1.1, cycle-034)
//
// Exponential Moving Average with configurable half-life, backed by atomic Redis Lua.
// O(1) query via cached EMA + local decay-at-query-time math.

import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { RedisCommandClient } from "../redis/client.js"
import type { PoolId } from "@0xhoneyjar/loa-hounfour"
import type { NFTRoutingKey } from "../nft-routing-config.js"

// --- Types ---

export interface TemporalDecayConfig {
  /** Half-life for task-cohort EMA (default: 7 days) */
  halfLifeMs: number
  /** Half-life for aggregate EMA (default: 30 days) */
  aggregateHalfLifeMs: number
  /** Redis command client for Lua eval */
  redis: RedisCommandClient
}

export interface EMAState {
  ema: number
  lastTimestamp: number
  sampleCount: number
  lastEventHash: string
}

export interface EMAKey {
  nftId: string
  poolId: PoolId
  routingKey: NFTRoutingKey
}

const LN2 = 0.693147

// --- Engine ---

export class TemporalDecayEngine {
  private readonly config: TemporalDecayConfig
  private readonly luaScript: string

  constructor(config: TemporalDecayConfig) {
    this.config = config

    // Load Lua script at construction time (once)
    const dir = dirname(fileURLToPath(import.meta.url))
    this.luaScript = readFileSync(join(dir, "lua", "ema-update.lua"), "utf-8")
  }

  /** Redis key for an EMA entry */
  private redisKey(key: EMAKey): string {
    return `finn:ema:${key.nftId}:${key.poolId}:${key.routingKey}`
  }

  /** TTL in seconds: 2 * halfLifeMs converted */
  private ttlSeconds(): number {
    return Math.ceil((2 * this.config.halfLifeMs) / 1000)
  }

  /**
   * Update EMA with a new observation. Atomic via Redis Lua script.
   * Handles cold start, idempotency (via eventHash), and out-of-order rejection.
   */
  async updateEMA(key: EMAKey, value: number, timestamp: number, eventHash: string): Promise<EMAState> {
    const redisKey = this.redisKey(key)
    const ttl = this.ttlSeconds()

    const result = await this.config.redis.eval(
      this.luaScript,
      1,
      redisKey,
      value,
      timestamp,
      this.config.halfLifeMs,
      ttl,
      eventHash,
    )

    return JSON.parse(result as string) as EMAState
  }

  /**
   * Query the decayed score at the current time. O(1): Redis GET + local math.
   * Returns null if no EMA state exists for this key.
   */
  async getDecayedScore(key: EMAKey): Promise<{ score: number; decay: "applied" | "unavailable" } | null> {
    const redisKey = this.redisKey(key)
    const raw = await this.config.redis.get(redisKey)

    if (raw === null) return null

    const state: EMAState = JSON.parse(raw)
    const now = Date.now()
    const dt = now - state.lastTimestamp

    if (dt <= 0) {
      // No decay needed — observation is current
      return { score: state.ema, decay: "applied" }
    }

    // Decay at query time: decayedScore = ema * exp(-ln(2) * dt / halfLife)
    const decayed = state.ema * Math.exp(-LN2 * dt / this.config.halfLifeMs)
    return { score: decayed, decay: "applied" }
  }

  /** Get raw EMA state without decay (for calibration blending) */
  async getRawState(key: EMAKey): Promise<EMAState | null> {
    const redisKey = this.redisKey(key)
    const raw = await this.config.redis.get(redisKey)
    if (raw === null) return null
    return JSON.parse(raw) as EMAState
  }
}
