// tests/finn/personality-version.test.ts — PersonalityVersionService tests (Sprint 3 Task 3.1-3.3)

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  PersonalityVersionService,
  VersionConflictError,
  generateUlid,
  type CreateVersionData,
} from "../../src/nft/personality-version.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"
import type { PersonalityVersion } from "../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Mock Redis (in-memory sorted sets + key-value store)
// ---------------------------------------------------------------------------

interface MockRedis extends RedisCommandClient {
  _store: Map<string, string>
  _sortedSets: Map<string, Array<{ member: string; score: number }>>
}

function createMockRedis(): MockRedis {
  const store = new Map<string, string>()
  const sortedSets = new Map<string, Array<{ member: string; score: number }>>()

  const redis: MockRedis = {
    _store: store,
    _sortedSets: sortedSets,

    async get(key: string) {
      return store.get(key) ?? null
    },

    async set(key: string, value: string) {
      store.set(key, value)
      return "OK"
    },

    async del(...keys: string[]) {
      let count = 0
      for (const k of keys) {
        if (store.delete(k)) count++
      }
      return count
    },

    async incrby(key: string, increment: number) {
      const val = parseInt(store.get(key) ?? "0", 10) + increment
      store.set(key, String(val))
      return val
    },

    async incrbyfloat(key: string, increment: number) {
      const val = parseFloat(store.get(key) ?? "0") + increment
      store.set(key, String(val))
      return String(val)
    },

    async expire() { return 1 },
    async exists(...keys: string[]) {
      let count = 0
      for (const k of keys) {
        if (store.has(k)) count++
      }
      return count
    },
    async ping() { return "PONG" },

    async hgetall() { return {} },
    async hincrby() { return 1 },

    async zadd(key: string, score: number, member: string) {
      const set = sortedSets.get(key) ?? []
      // Remove existing entry for this member
      const idx = set.findIndex(e => e.member === member)
      if (idx >= 0) set.splice(idx, 1)
      set.push({ member, score })
      // Sort by score ascending
      set.sort((a, b) => a.score - b.score)
      sortedSets.set(key, set)
      return 1
    },

    async zpopmin(key: string, count?: number) {
      const set = sortedSets.get(key) ?? []
      const n = count ?? 1
      const popped = set.splice(0, n)
      const result: string[] = []
      for (const p of popped) {
        result.push(p.member, String(p.score))
      }
      return result
    },

    async zremrangebyscore(key: string, min: string | number, max: string | number) {
      const set = sortedSets.get(key) ?? []
      const minN = min === "-inf" ? -Infinity : Number(min)
      const maxN = max === "+inf" ? Infinity : Number(max)
      const before = set.length
      const filtered = set.filter(e => e.score < minN || e.score > maxN)
      sortedSets.set(key, filtered)
      return before - filtered.length
    },

    async zcard(key: string) {
      return (sortedSets.get(key) ?? []).length
    },

    async publish() { return 0 },
    async quit() { return "OK" },

    // Lua script execution — simulate our specific scripts
    async eval(script: string, numkeys: number, ...args: (string | number)[]) {
      const keys = args.slice(0, numkeys) as string[]
      const argv = args.slice(numkeys)

      // Detect CREATE_VERSION_LUA script
      if (script.includes("ZADD") && script.includes("CONFLICT")) {
        const latestPtrKey = keys[0]
        const versionRecordKey = keys[1]
        const chainSortedSetKey = keys[2]
        const expectedLatest = String(argv[0])
        const newVersionId = String(argv[1])
        const versionJson = String(argv[2])
        const score = Number(argv[3])

        const current = store.get(latestPtrKey) ?? undefined

        if (expectedLatest === "") {
          // First version — expect no current latest
          if (current !== undefined) return "CONFLICT"
        } else {
          // Subsequent — expect current latest matches
          if (current !== expectedLatest) return "CONFLICT"
        }

        // Atomic write
        store.set(versionRecordKey, versionJson)
        await redis.zadd(chainSortedSetKey, score, newVersionId)
        store.set(latestPtrKey, newVersionId)
        return "OK"
      }

      // Detect GET_HISTORY_LUA script
      if (script.includes("ZREVRANGEBYSCORE")) {
        const chainSortedSetKey = keys[0]
        const cursorScore = String(argv[0])
        const limit = Number(argv[1])

        const set = sortedSets.get(chainSortedSetKey) ?? []
        const maxScore = cursorScore === "+inf" ? Infinity : Number(cursorScore)

        // Filter and sort descending
        const filtered = set
          .filter(e => e.score <= maxScore)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit + 1)

        // Return [member, score, member, score, ...]
        const result: string[] = []
        for (const entry of filtered) {
          result.push(entry.member, String(entry.score))
        }
        return result
      }

      return null
    },
  }

  return redis
}

// ---------------------------------------------------------------------------
// Mock codex-version loader
// ---------------------------------------------------------------------------

vi.mock("../../src/nft/codex-data/loader.js", () => ({
  loadCodexVersion: () => ({
    version: "0.1.0",
    sha: "test-sha",
    description: "Test codex",
    pinned_at: "2026-02-19T00:00:00Z",
  }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCreateData(overrides?: Partial<CreateVersionData>): CreateVersionData {
  return {
    beauvoir_md: "# Test Agent\n\nTest personality content.",
    signals: null,
    damp: null,
    authored_by: "0xTestWallet",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PersonalityVersionService", () => {
  let redis: MockRedis
  let service: PersonalityVersionService

  beforeEach(() => {
    redis = createMockRedis()
    service = new PersonalityVersionService({ redis })
  })

  // --- ULID Generation ---

  describe("generateUlid", () => {
    it("produces a 26-character string", () => {
      const ulid = generateUlid()
      expect(ulid).toHaveLength(26)
    })

    it("produces monotonically increasing IDs for increasing timestamps", () => {
      const a = generateUlid(1000)
      const b = generateUlid(2000)
      // Timestamp portion (first 10 chars) should be ordered
      expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true)
    })

    it("uses Crockford Base32 characters only", () => {
      const ulid = generateUlid()
      // Crockford Base32: 0-9, A-H, J-K, M-N, P-T, V-W, X-Z (no I, L, O, U)
      expect(ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/)
    })
  })

  // --- createVersion ---

  describe("createVersion", () => {
    it("generates a ULID version_id", async () => {
      const version = await service.createVersion("col:1", makeCreateData())
      expect(version.version_id).toHaveLength(26)
      expect(version.version_id).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/)
    })

    it("first version has previous_version_id null", async () => {
      const version = await service.createVersion("col:1", makeCreateData())
      expect(version.previous_version_id).toBeNull()
    })

    it("subsequent versions link to previous", async () => {
      const v1 = await service.createVersion("col:1", makeCreateData())
      const v2 = await service.createVersion("col:1", makeCreateData({
        beauvoir_md: "# Updated content",
      }))
      expect(v2.previous_version_id).toBe(v1.version_id)
    })

    it("stores version record retrievable by key", async () => {
      const version = await service.createVersion("col:1", makeCreateData())
      const key = `pv:col:1:${version.version_id}`
      const stored = redis._store.get(key)
      expect(stored).toBeTruthy()
      const parsed = JSON.parse(stored!)
      expect(parsed.version_id).toBe(version.version_id)
    })

    it("adds version to chain sorted set", async () => {
      const version = await service.createVersion("col:1", makeCreateData())
      const chain = redis._sortedSets.get("pv:chain:col:1")
      expect(chain).toBeTruthy()
      expect(chain!.length).toBe(1)
      expect(chain![0].member).toBe(version.version_id)
    })

    it("updates latest pointer", async () => {
      const v1 = await service.createVersion("col:1", makeCreateData())
      expect(redis._store.get("pv:latest:col:1")).toBe(v1.version_id)

      const v2 = await service.createVersion("col:1", makeCreateData())
      expect(redis._store.get("pv:latest:col:1")).toBe(v2.version_id)
    })

    it("stores personality_id on the version", async () => {
      const version = await service.createVersion("col:1", makeCreateData())
      expect(version.personality_id).toBe("col:1")
    })

    it("stores beauvoir_md content", async () => {
      const data = makeCreateData({ beauvoir_md: "# Custom Content" })
      const version = await service.createVersion("col:1", data)
      expect(version.beauvoir_md).toBe("# Custom Content")
    })

    it("stores authored_by", async () => {
      const version = await service.createVersion("col:1", makeCreateData({
        authored_by: "0xDeadBeef",
      }))
      expect(version.authored_by).toBe("0xDeadBeef")
    })

    it("stores created_at as Unix ms", async () => {
      const before = Date.now()
      const version = await service.createVersion("col:1", makeCreateData())
      const after = Date.now()
      expect(version.created_at).toBeGreaterThanOrEqual(before)
      expect(version.created_at).toBeLessThanOrEqual(after)
    })
  })

  // --- Codex Version Pinning (Task 3.3) ---

  describe("codex version pinning", () => {
    it("pins codex_version from loadCodexVersion()", async () => {
      const version = await service.createVersion("col:1", makeCreateData())
      expect(version.codex_version).toBe("0.1.0")
    })

    it("codex_version is immutable in stored record", async () => {
      const version = await service.createVersion("col:1", makeCreateData())
      const retrieved = await service.getVersion("col:1", version.version_id)
      expect(retrieved!.codex_version).toBe(version.codex_version)
    })
  })

  // --- Chain Integrity (Task 3.2) ---

  describe("chain integrity", () => {
    it("chain walk from latest to null reaches null with no cycles", async () => {
      const v1 = await service.createVersion("col:1", makeCreateData())
      const v2 = await service.createVersion("col:1", makeCreateData())
      const v3 = await service.createVersion("col:1", makeCreateData())

      // Walk from latest backward
      const chain: string[] = []
      let current: PersonalityVersion | null = await service.getLatest("col:1")
      const visited = new Set<string>()

      while (current) {
        expect(visited.has(current.version_id)).toBe(false) // no cycles
        visited.add(current.version_id)
        chain.push(current.version_id)

        if (current.previous_version_id) {
          current = await service.getVersion("col:1", current.previous_version_id)
        } else {
          current = null
        }
      }

      expect(chain).toEqual([v3.version_id, v2.version_id, v1.version_id])
      expect(chain.length).toBe(3)
    })

    it("first version in chain has previous_version_id null", async () => {
      await service.createVersion("col:1", makeCreateData())
      await service.createVersion("col:1", makeCreateData())

      // Walk to the first version
      let current = await service.getLatest("col:1")
      while (current && current.previous_version_id) {
        current = await service.getVersion("col:1", current.previous_version_id)
      }

      expect(current).toBeTruthy()
      expect(current!.previous_version_id).toBeNull()
    })
  })

  // --- VERSION_CONFLICT Detection ---

  describe("VERSION_CONFLICT", () => {
    it("detects conflict and retries successfully", async () => {
      // Create first version normally
      await service.createVersion("col:1", makeCreateData())

      // Simulate a conflict on first attempt by modifying the latest pointer
      // between the get and eval calls
      let callCount = 0
      const originalEval = redis.eval.bind(redis)
      redis.eval = vi.fn(async (script: string, numkeys: number, ...args: (string | number)[]) => {
        callCount++
        if (callCount === 1 && script.includes("CONFLICT")) {
          // Simulate another writer updating the latest pointer
          const latestKey = args[0] as string
          redis._store.set(latestKey, "INTERLOPER_VERSION")
        }
        return originalEval(script, numkeys, ...args)
      })

      // The service should retry and succeed on the second attempt
      // (because on retry, it re-reads the latest pointer)
      const v2 = await service.createVersion("col:1", makeCreateData())
      expect(v2).toBeTruthy()
      expect(v2.version_id).toHaveLength(26)
    })

    it("throws VersionConflictError after two consecutive conflicts", async () => {
      // Create first version
      await service.createVersion("col:1", makeCreateData())

      // Make eval always return CONFLICT for the create script
      redis.eval = vi.fn(async (script: string) => {
        if (script.includes("CONFLICT")) {
          return "CONFLICT"
        }
        return null
      })

      await expect(
        service.createVersion("col:1", makeCreateData()),
      ).rejects.toThrow(VersionConflictError)
    })

    it("VersionConflictError has httpStatus 409", async () => {
      const err = new VersionConflictError("col:1")
      expect(err.httpStatus).toBe(409)
      expect(err.message).toContain("VERSION_CONFLICT")
    })
  })

  // --- getVersion ---

  describe("getVersion", () => {
    it("returns stored version by ID", async () => {
      const created = await service.createVersion("col:1", makeCreateData())
      const retrieved = await service.getVersion("col:1", created.version_id)
      expect(retrieved).toEqual(created)
    })

    it("returns null for non-existent version", async () => {
      const result = await service.getVersion("col:1", "NONEXISTENT")
      expect(result).toBeNull()
    })

    it("returns null for corrupt JSON", async () => {
      redis._store.set("pv:col:1:BAD", "not-valid-json{{{")
      const result = await service.getVersion("col:1", "BAD")
      expect(result).toBeNull()
    })
  })

  // --- getLatest ---

  describe("getLatest", () => {
    it("returns most recent version", async () => {
      await service.createVersion("col:1", makeCreateData())
      const v2 = await service.createVersion("col:1", makeCreateData({
        beauvoir_md: "# Latest",
      }))

      const latest = await service.getLatest("col:1")
      expect(latest).toBeTruthy()
      expect(latest!.version_id).toBe(v2.version_id)
      expect(latest!.beauvoir_md).toBe("# Latest")
    })

    it("returns null when no versions exist", async () => {
      const result = await service.getLatest("col:nonexistent")
      expect(result).toBeNull()
    })
  })

  // --- getHistory ---

  describe("getHistory", () => {
    it("returns paginated results newest first", async () => {
      // Mock Date.now to return distinct timestamps so sorted set ordering is deterministic
      const baseTime = 1700000000000
      let callCount = 0
      const originalDateNow = Date.now
      vi.spyOn(Date, "now").mockImplementation(() => baseTime + (callCount++) * 1000)

      const versions: PersonalityVersion[] = []
      for (let i = 0; i < 5; i++) {
        const v = await service.createVersion("col:1", makeCreateData({
          beauvoir_md: `# Version ${i}`,
        }))
        versions.push(v)
      }

      // Restore Date.now before assertions
      vi.restoreAllMocks()

      const page = await service.getHistory("col:1", undefined, 3)
      expect(page.versions.length).toBe(3)
      // Newest first
      expect(page.versions[0].version_id).toBe(versions[4].version_id)
      expect(page.versions[1].version_id).toBe(versions[3].version_id)
      expect(page.versions[2].version_id).toBe(versions[2].version_id)
      // Has next cursor
      expect(page.next_cursor).not.toBeNull()
    })

    it("returns empty array when no versions exist", async () => {
      const page = await service.getHistory("col:nonexistent")
      expect(page.versions).toEqual([])
      expect(page.next_cursor).toBeNull()
    })

    it("returns all versions when limit exceeds count", async () => {
      await service.createVersion("col:1", makeCreateData())
      await service.createVersion("col:1", makeCreateData())

      const page = await service.getHistory("col:1", undefined, 100)
      expect(page.versions.length).toBe(2)
      expect(page.next_cursor).toBeNull()
    })

    it("defaults to limit 20 when not specified", async () => {
      // Create 3 versions (no need to create 20+)
      for (let i = 0; i < 3; i++) {
        await service.createVersion("col:1", makeCreateData())
      }

      const page = await service.getHistory("col:1")
      expect(page.versions.length).toBe(3)
      expect(page.next_cursor).toBeNull()
    })
  })

  // --- rollback ---

  describe("rollback", () => {
    it("creates a NEW version with old content", async () => {
      const v1 = await service.createVersion("col:1", makeCreateData({
        beauvoir_md: "# Original Content",
      }))
      await service.createVersion("col:1", makeCreateData({
        beauvoir_md: "# Modified Content",
      }))

      const rollbackVersion = await service.rollback("col:1", v1.version_id, "0xRollbackUser")

      // Should be a new version (different ID)
      expect(rollbackVersion.version_id).not.toBe(v1.version_id)
      // Content should match the original
      expect(rollbackVersion.beauvoir_md).toBe("# Original Content")
      // Previous should point to v2 (the version before rollback)
      expect(rollbackVersion.previous_version_id).toBeTruthy()
      // Author should be the rollback requester
      expect(rollbackVersion.authored_by).toBe("0xRollbackUser")
    })

    it("rollback version becomes the new latest", async () => {
      const v1 = await service.createVersion("col:1", makeCreateData({
        beauvoir_md: "# V1",
      }))
      await service.createVersion("col:1", makeCreateData({
        beauvoir_md: "# V2",
      }))

      await service.rollback("col:1", v1.version_id, "0xAdmin")

      const latest = await service.getLatest("col:1")
      expect(latest).toBeTruthy()
      expect(latest!.beauvoir_md).toBe("# V1")
      expect(latest!.change_summary).toContain("Rollback")
    })

    it("throws error for non-existent target version", async () => {
      await expect(
        service.rollback("col:1", "NONEXISTENT", "0xAdmin"),
      ).rejects.toThrow("Version not found")
    })

    it("preserves chain integrity after rollback", async () => {
      const v1 = await service.createVersion("col:1", makeCreateData({ beauvoir_md: "# V1" }))
      const v2 = await service.createVersion("col:1", makeCreateData({ beauvoir_md: "# V2" }))
      const v3 = await service.rollback("col:1", v1.version_id, "0xAdmin")

      // Walk chain: v3 -> v2 -> v1 -> null
      const chain: string[] = []
      let current: PersonalityVersion | null = await service.getLatest("col:1")
      while (current) {
        chain.push(current.version_id)
        if (current.previous_version_id) {
          current = await service.getVersion("col:1", current.previous_version_id)
        } else {
          current = null
        }
      }

      expect(chain).toEqual([v3.version_id, v2.version_id, v1.version_id])
    })
  })

  // --- Compatibility mode ---

  describe("compatibility_mode", () => {
    it("sets signal_v2 when signals are provided", async () => {
      const signals = {
        archetype: "freetekno" as const,
        ancestor: "ancestor-1",
        birthday: "1352-06-15",
        era: "medieval" as const,
        molecule: "DMT",
        tarot: { name: "The Fool", number: 0, suit: "major" as const, element: "air" as const },
        element: "air" as const,
        swag_rank: "S" as const,
        swag_score: 75,
        sun_sign: "aries" as const,
        moon_sign: "cancer" as const,
        ascending_sign: "leo" as const,
      }

      const version = await service.createVersion("col:1", makeCreateData({
        signals,
      }))
      expect(version.compatibility_mode).toBe("signal_v2")
    })

    it("sets legacy_v1 when signals are null", async () => {
      const version = await service.createVersion("col:1", makeCreateData({
        signals: null,
      }))
      expect(version.compatibility_mode).toBe("legacy_v1")
    })
  })
})
