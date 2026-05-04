// src/hounfour/goodhart/temporal-decay.ts — EMA Temporal Decay Engine (SDD §4.1.1, cycle-034)
//
// Exponential Moving Average with configurable half-life, backed by atomic Redis Lua.
// O(1) query via cached EMA + local decay-at-query-time math.

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

// Lua script inlined from lua/ema-update.lua (T-8.3: eliminates readFileSync blocking)
const EMA_UPDATE_LUA = `-- Atomic EMA Update (SDD §4.1.1)
--
-- KEYS[1] = finn:ema:{nftId}:{poolId}:{routingKey}
-- ARGV[1] = new observation value
-- ARGV[2] = observation timestamp (unix millis)
-- ARGV[3] = halfLifeMs
-- ARGV[4] = TTL seconds
-- ARGV[5] = event hash (for inline idempotency check)

-- 1. GET current state (idempotency is checked inline via lastEventHash)
local raw = redis.call("GET", KEYS[1])
local value = tonumber(ARGV[1])
local timestamp = tonumber(ARGV[2])
local halfLife = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

if raw == false then
  -- Cold start: first observation
  local state = cjson.encode({ema = value, lastTimestamp = timestamp, sampleCount = 1, lastEventHash = ARGV[5]})
  redis.call("SET", KEYS[1], state, "EX", ttl)
  return state
end

local state = cjson.decode(raw)

-- 2. Idempotency check: compare against last-seen event hash stored in EMA state
-- This is O(1) per key — no separate idempotency keys, no unbounded growth
if state.lastEventHash == ARGV[5] then
  return raw  -- Duplicate event, return existing state
end

-- 3. Out-of-order check
if timestamp < state.lastTimestamp then
  return raw  -- Drop stale event
end

-- 4. Compute alpha and new EMA
local dt = timestamp - state.lastTimestamp
local alpha = 1 - math.exp(-0.693147 * dt / halfLife)  -- ln(2) ≈ 0.693147
local newEma = alpha * value + (1 - alpha) * state.ema

-- 5. SET new state (include lastEventHash for idempotency)
local newState = cjson.encode({
  ema = newEma,
  lastTimestamp = timestamp,
  sampleCount = state.sampleCount + 1,
  lastEventHash = ARGV[5]
})
redis.call("SET", KEYS[1], newState, "EX", ttl)
return newState`

// --- Engine ---

export class TemporalDecayEngine {
  private readonly config: TemporalDecayConfig
  private readonly luaScript: string

  constructor(config: TemporalDecayConfig) {
    this.config = config
    this.luaScript = EMA_UPDATE_LUA
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
