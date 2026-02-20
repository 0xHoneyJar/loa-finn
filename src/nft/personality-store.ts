// src/nft/personality-store.ts — Write-Through Personality Store (Sprint 5 T5.4)
//
// Dual-write persistence: Redis (fast reads) + Postgres (durable).
// Read path: Redis → Postgres → on-chain reader fallback.
// Static config is seed data written to Postgres at first boot.

import type { RedisCommandClient } from "../hounfour/redis/client.js"
import type { PersonalityProvider, PersonalityConfig } from "./personality-provider.js"
import type { OnChainReader } from "./on-chain-reader.js"
import type { SignalSnapshot } from "./signal-types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonalityStoreConfig {
  redis: RedisCommandClient
  /** Postgres query functions (injected for testability) */
  pg: PersonalityStorePg
  /** On-chain reader for fallback signal reads */
  onChainReader?: OnChainReader
  /** Redis cache TTL in seconds (default: 3600 = 1h) */
  redisTtlSeconds?: number
  /** Redis key prefix (default: "finn:personality:") */
  keyPrefix?: string
}

/** Minimal Postgres interface for personality persistence. */
export interface PersonalityStorePg {
  getPersonalityByTokenId(tokenId: string): Promise<StoredPersonality | null>
  upsertPersonality(p: StoredPersonality): Promise<void>
  getLatestVersion(personalityId: string): Promise<StoredPersonalityVersion | null>
  insertVersion(v: StoredPersonalityVersion): Promise<void>
}

export interface StoredPersonality {
  id: string
  tokenId: string
  archetype: string
  currentVersionId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface StoredPersonalityVersion {
  id: string
  personalityId: string
  versionNumber: number
  beauvoirTemplate: string
  dampFingerprint: unknown | null
  epochNumber: number
  createdAt: Date
}

// ---------------------------------------------------------------------------
// PersonalityStore
// ---------------------------------------------------------------------------

export class PersonalityStore implements PersonalityProvider {
  private readonly redis: RedisCommandClient
  private readonly pg: PersonalityStorePg
  private readonly onChainReader: OnChainReader | undefined
  private readonly ttl: number
  private readonly keyPrefix: string

  constructor(config: PersonalityStoreConfig) {
    this.redis = config.redis
    this.pg = config.pg
    this.onChainReader = config.onChainReader
    this.ttl = config.redisTtlSeconds ?? 3600
    this.keyPrefix = config.keyPrefix ?? "finn:personality:"
  }

  /**
   * Get personality config for a tokenId.
   * Read path: Redis → Postgres → on-chain fallback.
   */
  async get(tokenId: string): Promise<PersonalityConfig | null> {
    // 1. Try Redis
    const cached = await this.getFromRedis(tokenId)
    if (cached) return cached

    // 2. Try Postgres
    const stored = await this.pg.getPersonalityByTokenId(tokenId)
    if (stored) {
      const version = stored.currentVersionId
        ? await this.pg.getLatestVersion(stored.id)
        : null

      const config = this.storedToConfig(stored, version)
      // Backfill Redis
      await this.setInRedis(tokenId, config)
      return config
    }

    // 3. No on-chain fallback for PersonalityConfig (on-chain gives SignalSnapshot, not PersonalityConfig)
    return null
  }

  async has(tokenId: string): Promise<boolean> {
    const result = await this.get(tokenId)
    return result !== null
  }

  /**
   * Write personality to both Redis and Postgres.
   * Used when seeding static config or updating from signal derivation.
   */
  async write(config: PersonalityConfig, personalityId: string): Promise<void> {
    const now = new Date()

    // Write to Postgres
    const existing = await this.pg.getPersonalityByTokenId(config.token_id)
    const latestVersion = existing ? await this.pg.getLatestVersion(existing.id) : null
    const nextVersionNum = latestVersion ? latestVersion.versionNumber + 1 : 1
    const versionId = generateUlid()

    if (!existing) {
      await this.pg.upsertPersonality({
        id: personalityId,
        tokenId: config.token_id,
        archetype: config.archetype,
        currentVersionId: versionId,
        createdAt: now,
        updatedAt: now,
      })
    } else {
      await this.pg.upsertPersonality({
        ...existing,
        archetype: config.archetype,
        currentVersionId: versionId,
        updatedAt: now,
      })
    }

    await this.pg.insertVersion({
      id: versionId,
      personalityId: existing?.id ?? personalityId,
      versionNumber: nextVersionNum,
      beauvoirTemplate: config.beauvoir_template,
      dampFingerprint: null,
      epochNumber: 0,
      createdAt: now,
    })

    // Write to Redis
    await this.setInRedis(config.token_id, config)
  }

  /**
   * Seed static personalities into Postgres (first boot).
   * Skips entries that already exist.
   */
  async seedFromStatic(configs: PersonalityConfig[]): Promise<number> {
    let seeded = 0
    for (const config of configs) {
      const existing = await this.pg.getPersonalityByTokenId(config.token_id)
      if (!existing) {
        await this.write(config, generateUlid())
        seeded++
      }
    }
    return seeded
  }

  /**
   * Invalidate Redis cache for a token.
   */
  async invalidate(tokenId: string): Promise<void> {
    await this.redis.del(this.cacheKey(tokenId))
  }

  // --- Redis helpers ---

  private async getFromRedis(tokenId: string): Promise<PersonalityConfig | null> {
    const raw = await this.redis.get(this.cacheKey(tokenId))
    if (!raw) return null
    try {
      return JSON.parse(raw) as PersonalityConfig
    } catch {
      await this.redis.del(this.cacheKey(tokenId))
      return null
    }
  }

  private async setInRedis(tokenId: string, config: PersonalityConfig): Promise<void> {
    await this.redis.set(this.cacheKey(tokenId), JSON.stringify(config), "EX", this.ttl)
  }

  private cacheKey(tokenId: string): string {
    return `${this.keyPrefix}${tokenId}`
  }

  // --- Conversion ---

  private storedToConfig(stored: StoredPersonality, version: StoredPersonalityVersion | null): PersonalityConfig {
    return {
      token_id: stored.tokenId,
      archetype: stored.archetype as PersonalityConfig["archetype"],
      display_name: stored.tokenId,
      voice_description: "",
      behavioral_traits: [],
      expertise_domains: [],
      beauvoir_template: version?.beauvoirTemplate ?? "",
    }
  }
}

// ---------------------------------------------------------------------------
// ULID generation (simplified — monotonic, sortable)
// ---------------------------------------------------------------------------

let lastTime = 0
let seq = 0

function generateUlid(): string {
  const now = Date.now()
  if (now === lastTime) {
    seq++
  } else {
    lastTime = now
    seq = 0
  }
  const timePart = now.toString(36).padStart(10, "0")
  const seqPart = seq.toString(36).padStart(4, "0")
  const randPart = Math.random().toString(36).slice(2, 8)
  return `${timePart}${seqPart}${randPart}`.toUpperCase()
}
