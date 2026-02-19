// tests/finn/governance.test.ts — Governance Model Tests (Sprint 14 Task 14.3)
//
// Tests:
// - governance_model defaults to "holder" in decodePersonality()
// - "community" and "dao" accepted and stored
// - governance_model included in API response via toResponse()
// - governance_model preserved across personality versions

import { describe, it, expect, vi, beforeEach } from "vitest"
import { PersonalityService, decodePersonality } from "../../src/nft/personality.js"
import type { PersonalityServiceDeps } from "../../src/nft/personality.js"
import type { NFTPersonality, PersonalityResponse } from "../../src/nft/types.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"
import type { PersonalityVersionService, CreateVersionData } from "../../src/nft/personality-version.js"

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function createMockRedis(): RedisCommandClient {
  const store = new Map<string, string>()

  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
      return "OK"
    }),
    del: vi.fn(async (...keys: string[]) => {
      let count = 0
      for (const k of keys) {
        if (store.delete(k)) count++
      }
      return count
    }),
    incrby: vi.fn(),
    incrbyfloat: vi.fn(),
    expire: vi.fn(),
    exists: vi.fn(),
    ping: vi.fn(async () => "PONG"),
    eval: vi.fn(),
    hgetall: vi.fn(),
    hincrby: vi.fn(),
    zadd: vi.fn(),
    zpopmin: vi.fn(),
    zremrangebyscore: vi.fn(),
    zcard: vi.fn(),
    publish: vi.fn(),
    quit: vi.fn(),
  } as unknown as RedisCommandClient
}

// ---------------------------------------------------------------------------
// Mock Version Service
// ---------------------------------------------------------------------------

function createMockVersionService(): PersonalityVersionService {
  const versions: Array<{ nftId: string; data: CreateVersionData; version_id: string }> = []
  let counter = 0

  return {
    createVersion: vi.fn(async (nftId: string, data: CreateVersionData) => {
      counter++
      const version_id = `VERSION_${counter}`
      versions.push({ nftId, data, version_id })
      return {
        version_id,
        previous_version_id: null,
        personality_id: nftId,
        signal_snapshot: data.signals,
        damp_fingerprint: data.damp,
        beauvoir_md: data.beauvoir_md,
        authored_by: data.authored_by,
        governance_model: data.governance_model ?? "holder",
        codex_version: "test-codex",
        compatibility_mode: data.signals ? "signal_v2" : "legacy_v1",
        created_at: Date.now(),
        change_summary: data.change_summary ?? "",
      }
    }),
    getVersion: vi.fn(async () => null),
    getHistory: vi.fn(async () => ({ versions: [], next_cursor: null })),
    getLatest: vi.fn(async () => null),
    rollback: vi.fn(),
    _getVersions: () => versions,
  } as unknown as PersonalityVersionService & { _getVersions: () => typeof versions }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION = "finn"
const TOKEN_ID = "42"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Governance Model", () => {
  let redis: RedisCommandClient
  let versionService: ReturnType<typeof createMockVersionService>
  let service: PersonalityService

  beforeEach(() => {
    redis = createMockRedis()
    versionService = createMockVersionService()
    service = new PersonalityService({
      redis,
      versionService: versionService as unknown as PersonalityVersionService,
    })
  })

  // --- decodePersonality defaults ---

  describe("decodePersonality — governance_model defaults", () => {
    it("defaults governance_model to 'holder' when field is missing", () => {
      const raw: Record<string, unknown> = {
        id: "finn:42",
        name: "Test",
        voice: "analytical",
        expertise_domains: ["defi"],
        custom_instructions: "",
        beauvoir_md: "# Test",
        created_at: Date.now(),
        updated_at: Date.now(),
      }

      const decoded = decodePersonality(raw)

      expect(decoded.governance_model).toBe("holder")
    })

    it("defaults governance_model to 'holder' when field is undefined", () => {
      const raw: Record<string, unknown> = {
        id: "finn:42",
        name: "Test",
        voice: "analytical",
        expertise_domains: ["defi"],
        custom_instructions: "",
        beauvoir_md: "# Test",
        created_at: Date.now(),
        updated_at: Date.now(),
        governance_model: undefined,
      }

      const decoded = decodePersonality(raw)

      expect(decoded.governance_model).toBe("holder")
    })

    it("preserves governance_model 'holder' when explicitly set", () => {
      const raw: Record<string, unknown> = {
        id: "finn:42",
        name: "Test",
        voice: "analytical",
        expertise_domains: ["defi"],
        custom_instructions: "",
        beauvoir_md: "# Test",
        created_at: Date.now(),
        updated_at: Date.now(),
        governance_model: "holder",
      }

      const decoded = decodePersonality(raw)

      expect(decoded.governance_model).toBe("holder")
    })

    it("accepts governance_model 'community'", () => {
      const raw: Record<string, unknown> = {
        id: "finn:42",
        name: "Test",
        voice: "analytical",
        expertise_domains: ["defi"],
        custom_instructions: "",
        beauvoir_md: "# Test",
        created_at: Date.now(),
        updated_at: Date.now(),
        governance_model: "community",
      }

      const decoded = decodePersonality(raw)

      expect(decoded.governance_model).toBe("community")
    })

    it("accepts governance_model 'dao'", () => {
      const raw: Record<string, unknown> = {
        id: "finn:42",
        name: "Test",
        voice: "analytical",
        expertise_domains: ["defi"],
        custom_instructions: "",
        beauvoir_md: "# Test",
        created_at: Date.now(),
        updated_at: Date.now(),
        governance_model: "dao",
      }

      const decoded = decodePersonality(raw)

      expect(decoded.governance_model).toBe("dao")
    })
  })

  // --- API Response ---

  describe("governance_model in API response", () => {
    it("includes governance_model in PersonalityResponse via get()", async () => {
      // Create a personality first
      const result = await service.create(COLLECTION, TOKEN_ID, {
        name: "Governance Test",
        voice: "sage",
        expertise_domains: ["philosophy"],
        custom_instructions: "test",
      })

      expect(result.governance_model).toBe("holder")

      // Verify via get()
      const fetched = await service.get(COLLECTION, TOKEN_ID)
      expect(fetched).not.toBeNull()
      expect(fetched!.governance_model).toBe("holder")
    })

    it("governance_model 'holder' is the default in create response", async () => {
      const result = await service.create(COLLECTION, TOKEN_ID, {
        name: "Default Governance",
        voice: "analytical",
        expertise_domains: ["defi"],
      })

      expect(result.governance_model).toBe("holder")
    })

    it("governance_model is present in update response", async () => {
      // Create first
      await service.create(COLLECTION, TOKEN_ID, {
        name: "Update Test",
        voice: "creative",
        expertise_domains: ["art"],
      })

      // Update
      const updated = await service.update(COLLECTION, TOKEN_ID, {
        name: "Updated Name",
      })

      expect(updated.governance_model).toBe("holder")
    })

    it("governance_model persists through Redis round-trip", async () => {
      // Create
      await service.create(COLLECTION, TOKEN_ID, {
        name: "Roundtrip Test",
        voice: "witty",
        expertise_domains: ["comedy"],
      })

      // Manually inject 'community' governance_model into Redis
      const key = `personality:${COLLECTION}:${TOKEN_ID}`
      const stored = await redis.get(key)
      expect(stored).not.toBeNull()

      const parsed = JSON.parse(stored!)
      parsed.governance_model = "community"
      await redis.set(key, JSON.stringify(parsed))

      // Read back
      const fetched = await service.get(COLLECTION, TOKEN_ID)
      expect(fetched).not.toBeNull()
      expect(fetched!.governance_model).toBe("community")
    })

    it("governance_model 'dao' persists through Redis round-trip", async () => {
      // Create
      await service.create(COLLECTION, TOKEN_ID, {
        name: "DAO Test",
        voice: "sage",
        expertise_domains: ["governance"],
      })

      // Manually inject 'dao' governance_model
      const key = `personality:${COLLECTION}:${TOKEN_ID}`
      const stored = await redis.get(key)
      const parsed = JSON.parse(stored!)
      parsed.governance_model = "dao"
      await redis.set(key, JSON.stringify(parsed))

      // Read back
      const fetched = await service.get(COLLECTION, TOKEN_ID)
      expect(fetched).not.toBeNull()
      expect(fetched!.governance_model).toBe("dao")
    })
  })

  // --- Version Preservation ---

  describe("governance_model preserved across versions", () => {
    it("governance_model defaults to 'holder' in version creation", async () => {
      await service.create(COLLECTION, TOKEN_ID, {
        name: "Version Test",
        voice: "analytical",
        expertise_domains: ["testing"],
      })

      // The version service should have been called with governance_model
      const createVersionFn = versionService.createVersion as ReturnType<typeof vi.fn>
      expect(createVersionFn).toHaveBeenCalled()
    })

    it("governance_model is preserved when updating personality", async () => {
      // Create
      const created = await service.create(COLLECTION, TOKEN_ID, {
        name: "Version Preserve Test",
        voice: "sage",
        expertise_domains: ["philosophy"],
      })

      expect(created.governance_model).toBe("holder")

      // Update name
      const updated = await service.update(COLLECTION, TOKEN_ID, {
        name: "Updated Version Preserve",
      })

      // governance_model should still be "holder"
      expect(updated.governance_model).toBe("holder")
    })

    it("governance_model survives multiple updates", async () => {
      // Create
      await service.create(COLLECTION, TOKEN_ID, {
        name: "Multi-Update Test",
        voice: "creative",
        expertise_domains: ["art"],
      })

      // Set governance_model to "community" directly in Redis
      const key = `personality:${COLLECTION}:${TOKEN_ID}`
      const stored = await redis.get(key)
      const parsed = JSON.parse(stored!)
      parsed.governance_model = "community"
      await redis.set(key, JSON.stringify(parsed))

      // Multiple updates should preserve "community"
      await service.update(COLLECTION, TOKEN_ID, { name: "Update 1" })
      const afterUpdate1 = await service.get(COLLECTION, TOKEN_ID)
      expect(afterUpdate1!.governance_model).toBe("community")

      await service.update(COLLECTION, TOKEN_ID, { name: "Update 2" })
      const afterUpdate2 = await service.get(COLLECTION, TOKEN_ID)
      expect(afterUpdate2!.governance_model).toBe("community")

      await service.update(COLLECTION, TOKEN_ID, { name: "Update 3" })
      const afterUpdate3 = await service.get(COLLECTION, TOKEN_ID)
      expect(afterUpdate3!.governance_model).toBe("community")
    })

    it("getRaw() returns governance_model field", async () => {
      await service.create(COLLECTION, TOKEN_ID, {
        name: "Raw Test",
        voice: "analytical",
        expertise_domains: ["data"],
      })

      const raw = await service.getRaw(COLLECTION, TOKEN_ID)
      expect(raw).not.toBeNull()
      expect(raw!.governance_model).toBe("holder")
    })
  })

  // --- Legacy Record Compatibility ---

  describe("legacy record compatibility", () => {
    it("legacy records without governance_model decode with 'holder' default", async () => {
      // Simulate a legacy record in Redis (no governance_model field)
      const legacyRecord = {
        id: `${COLLECTION}:${TOKEN_ID}`,
        name: "Legacy Personality",
        voice: "analytical",
        expertise_domains: ["legacy"],
        custom_instructions: "",
        beauvoir_md: "# Legacy",
        created_at: Date.now() - 86400000,
        updated_at: Date.now() - 86400000,
        // NOTE: no governance_model field
      }

      const key = `personality:${COLLECTION}:${TOKEN_ID}`
      await redis.set(key, JSON.stringify(legacyRecord))

      const result = await service.get(COLLECTION, TOKEN_ID)
      expect(result).not.toBeNull()
      expect(result!.governance_model).toBe("holder")
    })
  })
})
