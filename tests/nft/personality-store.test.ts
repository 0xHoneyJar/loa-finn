// tests/nft/personality-store.test.ts — Write-Through Personality Store Tests (Sprint 5 T5.4)

import { describe, it, expect, beforeEach } from "vitest"
import { PersonalityStore } from "../../src/nft/personality-store.js"
import type { PersonalityStorePg, StoredPersonality, StoredPersonalityVersion } from "../../src/nft/personality-store.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"
import type { PersonalityConfig } from "../../src/nft/personality-provider.js"

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function createMockRedis(): RedisCommandClient {
  const store = new Map<string, { value: string; expiresAt: number }>()

  function isExpired(key: string): boolean {
    const entry = store.get(key)
    if (!entry) return true
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      store.delete(key)
      return true
    }
    return false
  }

  return {
    async get(key: string) {
      if (isExpired(key)) return null
      return store.get(key)?.value ?? null
    },
    async set(key: string, value: string, ...args: (string | number)[]) {
      let ttlMs = 0
      for (let i = 0; i < args.length; i++) {
        if (String(args[i]).toUpperCase() === "EX" && i + 1 < args.length) {
          ttlMs = Number(args[i + 1]) * 1000
        }
      }
      store.set(key, {
        value,
        expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0,
      })
      return "OK"
    },
    async del(...keys: string[]) {
      let count = 0
      for (const key of keys) {
        if (store.delete(key)) count++
      }
      return count
    },
    async exists(...keys: string[]) {
      let count = 0
      for (const key of keys) {
        if (!isExpired(key) && store.has(key)) count++
      }
      return count
    },
    async incrby() { return 0 },
    async incrbyfloat() { return "0" },
    async expire() { return 0 },
    async ping() { return "PONG" },
    async eval() { return null },
    async hgetall() { return {} },
    async hincrby() { return 0 },
    async zadd() { return 0 },
    async zpopmin() { return [] },
    async zremrangebyscore() { return 0 },
    async zcard() { return 0 },
  } as RedisCommandClient
}

// ---------------------------------------------------------------------------
// Mock Postgres
// ---------------------------------------------------------------------------

function createMockPg(): PersonalityStorePg & {
  personalities: Map<string, StoredPersonality>
  versions: Map<string, StoredPersonalityVersion[]>
} {
  const personalities = new Map<string, StoredPersonality>()
  const versions = new Map<string, StoredPersonalityVersion[]>()

  return {
    personalities,
    versions,
    async getPersonalityByTokenId(tokenId: string) {
      for (const p of personalities.values()) {
        if (p.tokenId === tokenId) return p
      }
      return null
    },
    async upsertPersonality(p: StoredPersonality) {
      personalities.set(p.id, p)
    },
    async getLatestVersion(personalityId: string) {
      const v = versions.get(personalityId)
      if (!v || v.length === 0) return null
      return v[v.length - 1]
    },
    async insertVersion(v: StoredPersonalityVersion) {
      const existing = versions.get(v.personalityId) ?? []
      existing.push(v)
      versions.set(v.personalityId, existing)
    },
  }
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const FREETEKNO_CONFIG: PersonalityConfig = {
  token_id: "1",
  archetype: "freetekno",
  display_name: "Rave Spirit",
  voice_description: "Underground rave energy",
  behavioral_traits: ["rebellious", "free-spirited"],
  expertise_domains: ["electronic music", "counterculture"],
  beauvoir_template: "You are a free-spirited rave entity.",
}

const MILADY_CONFIG: PersonalityConfig = {
  token_id: "2",
  archetype: "milady",
  display_name: "Milady",
  voice_description: "Aesthetic post-irony",
  behavioral_traits: ["ironic", "aesthetic"],
  expertise_domains: ["internet culture", "art"],
  beauvoir_template: "You are an aesthetic post-ironic entity.",
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T5.4: PersonalityStore — write and read", () => {
  let store: PersonalityStore
  let pg: ReturnType<typeof createMockPg>
  let redis: RedisCommandClient

  beforeEach(() => {
    redis = createMockRedis()
    pg = createMockPg()
    store = new PersonalityStore({ redis, pg })
  })

  it("returns null for unknown tokenId", async () => {
    const result = await store.get("unknown")
    expect(result).toBeNull()
  })

  it("writes personality to both Redis and Postgres", async () => {
    await store.write(FREETEKNO_CONFIG, "p-001")

    // Check Postgres
    expect(pg.personalities.size).toBe(1)
    const personality = pg.personalities.get("p-001")
    expect(personality?.tokenId).toBe("1")
    expect(personality?.archetype).toBe("freetekno")

    // Check versions
    const versions = pg.versions.get("p-001")
    expect(versions).toHaveLength(1)
    expect(versions![0].beauvoirTemplate).toBe("You are a free-spirited rave entity.")

    // Check Redis (via get)
    const cached = await store.get("1")
    expect(cached?.archetype).toBe("freetekno")
  })

  it("reads from Redis on cache hit (no Postgres call)", async () => {
    await store.write(FREETEKNO_CONFIG, "p-001")

    // Clear Postgres to prove Redis is being used
    pg.personalities.clear()
    pg.versions.clear()

    const result = await store.get("1")
    expect(result).not.toBeNull()
    expect(result!.archetype).toBe("freetekno")
  })

  it("reads from Postgres on Redis miss", async () => {
    await store.write(FREETEKNO_CONFIG, "p-001")

    // Invalidate Redis cache
    await store.invalidate("1")

    const result = await store.get("1")
    expect(result).not.toBeNull()
    expect(result!.token_id).toBe("1")
  })

  it("has() returns true for existing personality", async () => {
    await store.write(FREETEKNO_CONFIG, "p-001")
    expect(await store.has("1")).toBe(true)
    expect(await store.has("unknown")).toBe(false)
  })
})

describe("T5.4: PersonalityStore — seedFromStatic", () => {
  it("seeds multiple personalities", async () => {
    const pg = createMockPg()
    const store = new PersonalityStore({ redis: createMockRedis(), pg })

    const seeded = await store.seedFromStatic([FREETEKNO_CONFIG, MILADY_CONFIG])
    expect(seeded).toBe(2)
    expect(pg.personalities.size).toBe(2)
  })

  it("skips already-existing personalities", async () => {
    const pg = createMockPg()
    const store = new PersonalityStore({ redis: createMockRedis(), pg })

    // Seed once
    await store.seedFromStatic([FREETEKNO_CONFIG])
    expect(pg.personalities.size).toBe(1)

    // Seed again with same + new
    const seeded = await store.seedFromStatic([FREETEKNO_CONFIG, MILADY_CONFIG])
    expect(seeded).toBe(1) // Only milady is new
    expect(pg.personalities.size).toBe(2)
  })
})

describe("T5.4: PersonalityStore — version updates", () => {
  it("creates new version on re-write", async () => {
    const pg = createMockPg()
    const store = new PersonalityStore({ redis: createMockRedis(), pg })

    await store.write(FREETEKNO_CONFIG, "p-001")

    const updated = { ...FREETEKNO_CONFIG, beauvoir_template: "Updated template." }
    await store.write(updated, "p-001")

    // Should have 2 versions
    const versions = pg.versions.get("p-001")
    expect(versions).toHaveLength(2)
    expect(versions![0].versionNumber).toBe(1)
    expect(versions![1].versionNumber).toBe(2)
    expect(versions![1].beauvoirTemplate).toBe("Updated template.")
  })
})

describe("T5.4: PersonalityStore — invalidate", () => {
  it("removes Redis cache, next read hits Postgres", async () => {
    const pg = createMockPg()
    const redis = createMockRedis()
    const store = new PersonalityStore({ redis, pg })

    await store.write(FREETEKNO_CONFIG, "p-001")

    // Verify cached
    expect(await redis.exists("finn:personality:1")).toBe(1)

    // Invalidate
    await store.invalidate("1")
    expect(await redis.exists("finn:personality:1")).toBe(0)

    // Read still works (from Postgres)
    const result = await store.get("1")
    expect(result).not.toBeNull()
  })
})
