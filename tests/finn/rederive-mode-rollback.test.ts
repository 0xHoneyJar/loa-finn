// tests/finn/rederive-mode-rollback.test.ts — Sprint 15 Re-derive, Mode Switch, Rollback Tests
//
// Tests for the three new V2 endpoints added in Sprint 15:
// - POST /:collection/:tokenId/personality/rederive (Task 15.1)
// - POST /:collection/:tokenId/mode (Task 15.2)
// - POST /:collection/:tokenId/personality/rollback/:versionId (Task 15.3)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import {
  PersonalityService,
  handleRederive,
  handleModeSwitch,
  handleRollback,
} from "../../src/nft/personality.js"
import type {
  PersonalityServiceDeps,
  PersonalityV2Deps,
} from "../../src/nft/personality.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"
import type { NFTPersonality } from "../../src/nft/types.js"
import type { SignalSnapshot, DAMPFingerprint, AgentMode, PersonalityVersion } from "../../src/nft/signal-types.js"
import { resolvePersonalityPrompt } from "../../src/nft/personality-resolver.js"

// ---------------------------------------------------------------------------
// Mock Redis (minimal key-value with sorted set + Lua support)
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
      const idx = set.findIndex(e => e.member === member)
      if (idx >= 0) set.splice(idx, 1)
      set.push({ member, score })
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
          if (current !== undefined) return "CONFLICT"
        } else {
          if (current !== expectedLatest) return "CONFLICT"
        }

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

        const filtered = set
          .filter(e => e.score <= maxScore)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit + 1)

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
// Mocks — module-level
// ---------------------------------------------------------------------------

// Mock codex-data/loader.js — control codex version for rederive tests
const mockLoadCodexVersion = vi.fn()

vi.mock("../../src/nft/codex-data/loader.js", () => ({
  loadCodexVersion: () => mockLoadCodexVersion(),
  loadAncestors: () => [],
  loadMoleculeTarotBijection: () => [],
  loadArchetypeDefinitions: () => [],
  loadArchetypeAffinity: () => ({}),
  loadDAMPTables: () => ({}),
  loadArtifact: () => ({ data: {}, checksum: "mock", valid: true }),
  registerArtifact: () => {},
  clearArtifactCache: () => {},
  getRegisteredArtifacts: () => [],
}))

// Mock damp.js — control deriveDAMP output
const mockDeriveDAMP = vi.fn()

vi.mock("../../src/nft/damp.js", () => ({
  deriveDAMP: (...args: unknown[]) => mockDeriveDAMP(...args),
  resolveAncestorFamily: () => "hellenic",
  normalizeSwag: () => 0.5,
  deriveAstrologyBlend: () => 0.5,
  clampModeOffset: (v: number) => Math.max(-0.3, Math.min(0.3, v)),
  ANCESTOR_TO_FAMILY: {},
  ANCESTOR_FAMILIES: [],
}))

// Mock beauvoir-template
vi.mock("../../src/nft/beauvoir-template.js", () => ({
  generateBeauvoirMd: (name: string) => `# ${name}\n\nGenerated BEAUVOIR.md`,
  DEFAULT_BEAUVOIR_MD: "# Default\n",
}))

// Mock identity-graph (avoid filesystem codex loading)
vi.mock("../../src/nft/identity-graph.js", () => ({
  KnowledgeGraphLoader: class {
    load = vi.fn()
    reset = vi.fn()
  },
  extractSubgraph: vi.fn(),
  toSynthesisSubgraph: vi.fn(),
  IdentityGraphCache: class {
    async get() { return null }
    async set() {}
  },
  resolveCulturalReferences: () => [],
  resolveAestheticPreferences: () => [],
  resolvePhilosophicalFoundations: () => [],
}))

// Mock safety-policy
vi.mock("../../src/nft/safety-policy.js", () => ({
  getSafetyPolicyText: () => "Safety constraints apply.",
}))

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeSignalSnapshot(overrides?: Partial<SignalSnapshot>): SignalSnapshot {
  return {
    archetype: "freetekno",
    ancestor: "greek_philosopher",
    birthday: "1352-06-15",
    era: "medieval",
    molecule: "DMT",
    tarot: { name: "The Fool", number: 0, suit: "major", element: "air" },
    element: "air",
    swag_rank: "S",
    swag_score: 75,
    sun_sign: "aries",
    moon_sign: "scorpio",
    ascending_sign: "leo",
    ...overrides,
  }
}

function makeDAMPFingerprint(mode: AgentMode = "default"): DAMPFingerprint {
  const dials = {} as Record<string, number>
  // Create 96 dials with deterministic values
  const categories = ["sw", "cs", "as", "cg", "ep", "cr", "cv", "mo", "et", "sc", "ag", "id"]
  const dialNames = [
    "approachability", "emotional_attunement", "generosity", "trust_default",
    "physical_metaphor_warmth", "humor_use", "vulnerability_tolerance", "group_inclusion",
  ]
  for (const cat of categories) {
    for (const name of dialNames) {
      dials[`${cat}_${name}`] = 0.5
    }
  }
  return {
    dials: dials as DAMPFingerprint["dials"],
    mode,
    derived_from: "test-sha",
    derived_at: Date.now(),
  }
}

function makePersonality(overrides?: Partial<NFTPersonality>): NFTPersonality {
  return {
    id: "testcol:1",
    name: "TestAgent",
    voice: "analytical",
    expertise_domains: ["defi", "nfts"],
    custom_instructions: "",
    beauvoir_md: "# TestAgent\n\nGenerated BEAUVOIR.md",
    created_at: Date.now() - 10000,
    updated_at: Date.now() - 5000,
    compatibility_mode: "signal_v2",
    signals: makeSignalSnapshot(),
    damp: makeDAMPFingerprint(),
    version_id: "VERSION_001",
    previous_version_id: null,
    authored_by: "0xTestWallet",
    governance_model: "holder",
    voice_profile: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test Setup
// ---------------------------------------------------------------------------

function createTestDeps(
  redis: MockRedis,
  overrides?: Partial<PersonalityV2Deps>,
): { service: PersonalityService; deps: PersonalityV2Deps } {
  const serviceDeps: PersonalityServiceDeps = {
    redis,
    walAppend: () => "wal-id",
  }
  const service = new PersonalityService(serviceDeps)

  const deps: PersonalityV2Deps = {
    service,
    ownershipProvider: {
      getOwnerOf: async () => "0xtestwallet",
      onTransfer: () => {},
    },
    ownershipMiddlewareConfig: {
      jwtPublicKey: new Uint8Array(32),
    },
    redis,
    ...overrides,
  }

  return { service, deps }
}

/** Seed a personality into mock Redis */
async function seedPersonality(redis: MockRedis, personality: NFTPersonality): Promise<void> {
  const key = `personality:${personality.id}`
  await redis.set(key, JSON.stringify(personality))
}

// ---------------------------------------------------------------------------
// Tests: Re-derive Endpoint (Task 15.1)
// ---------------------------------------------------------------------------

describe("handleRederive", () => {
  let redis: MockRedis
  let deps: PersonalityV2Deps

  beforeEach(() => {
    vi.clearAllMocks()
    redis = createMockRedis()
    const setup = createTestDeps(redis)
    deps = setup.deps

    // Default mock behavior
    mockLoadCodexVersion.mockReturnValue({
      version: "0.2.0",
      sha: "new-sha",
      description: "Updated codex",
      pinned_at: "2026-02-19T00:00:00Z",
    })
    mockDeriveDAMP.mockReturnValue(makeDAMPFingerprint())
  })

  it("returns 404 when personality does not exist", async () => {
    const app = new Hono()
    app.post("/:collection/:tokenId/personality/rederive", (c) => handleRederive(c, deps))

    const res = await app.request("/testcol/999/personality/rederive", {
      method: "POST",
    })

    expect(res.status).toBe(404)
    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("PERSONALITY_NOT_FOUND")
  })

  it("returns 400 for legacy_v1 personality (no signals)", async () => {
    const legacyPersonality = makePersonality({
      compatibility_mode: "legacy_v1",
      signals: null,
    })
    await seedPersonality(redis, legacyPersonality)

    const app = new Hono()
    app.post("/:collection/:tokenId/personality/rederive", (c) => handleRederive(c, deps))

    const res = await app.request("/testcol/1/personality/rederive", {
      method: "POST",
    })

    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("INVALID_REQUEST")
    expect(body.error).toContain("legacy_v1")
  })

  it("returns 409 CODEX_UNCHANGED when version has same codex version", async () => {
    const personality = makePersonality()
    await seedPersonality(redis, personality)

    // Mock version service that returns a version with the same codex version
    const mockVersionService = {
      createVersion: vi.fn(),
      getVersion: vi.fn(),
      getHistory: vi.fn(),
      getLatest: vi.fn().mockResolvedValue({
        version_id: "VERSION_001",
        codex_version: "0.2.0", // Same as loadCodexVersion mock
        personality_id: "testcol:1",
        signal_snapshot: personality.signals,
        damp_fingerprint: personality.damp,
        beauvoir_md: personality.beauvoir_md,
        authored_by: "0xTestWallet",
        governance_model: "holder",
        compatibility_mode: "signal_v2",
        created_at: Date.now(),
        change_summary: "",
        previous_version_id: null,
      }),
      rollback: vi.fn(),
    }

    const setupWithVersion = createTestDeps(redis, {
      versionService: mockVersionService as any,
    })

    const app = new Hono()
    app.post("/:collection/:tokenId/personality/rederive", (c) => handleRederive(c, setupWithVersion.deps))

    const res = await app.request("/testcol/1/personality/rederive", {
      method: "POST",
    })

    expect(res.status).toBe(409)
    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("CODEX_UNCHANGED")
  })

  it("re-derives successfully when codex version has changed", async () => {
    const personality = makePersonality()
    await seedPersonality(redis, personality)

    // Mock version service with older codex version
    const mockVersionService = {
      createVersion: vi.fn(),
      getVersion: vi.fn(),
      getHistory: vi.fn(),
      getLatest: vi.fn().mockResolvedValue({
        version_id: "VERSION_001",
        codex_version: "0.1.0", // Older than loadCodexVersion mock (0.2.0)
        personality_id: "testcol:1",
        signal_snapshot: personality.signals,
        damp_fingerprint: personality.damp,
        beauvoir_md: personality.beauvoir_md,
        authored_by: "0xTestWallet",
        governance_model: "holder",
        compatibility_mode: "signal_v2",
        created_at: Date.now(),
        change_summary: "",
        previous_version_id: null,
      }),
      rollback: vi.fn(),
    }

    const setupWithVersion = createTestDeps(redis, {
      versionService: mockVersionService as any,
    })

    const app = new Hono()
    app.post("/:collection/:tokenId/personality/rederive", (c) => handleRederive(c, setupWithVersion.deps))

    const res = await app.request("/testcol/1/personality/rederive", {
      method: "POST",
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.rederived).toBe(true)
    expect(body.codex_version).toBe("0.2.0")
    expect(mockDeriveDAMP).toHaveBeenCalledWith(personality.signals, "default")
  })

  it("re-derives without version service (no codex check)", async () => {
    const personality = makePersonality()
    await seedPersonality(redis, personality)

    // No versionService — skips codex version comparison
    const app = new Hono()
    app.post("/:collection/:tokenId/personality/rederive", (c) => handleRederive(c, deps))

    const res = await app.request("/testcol/1/personality/rederive", {
      method: "POST",
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.rederived).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests: Mode Switch Endpoint (Task 15.2)
// ---------------------------------------------------------------------------

describe("handleModeSwitch", () => {
  let redis: MockRedis
  let deps: PersonalityV2Deps

  beforeEach(() => {
    vi.clearAllMocks()
    redis = createMockRedis()
    const setup = createTestDeps(redis)
    deps = setup.deps

    mockLoadCodexVersion.mockReturnValue({
      version: "0.1.0",
      sha: "test-sha",
      description: "Test codex",
      pinned_at: "2026-02-19T00:00:00Z",
    })
  })

  it("returns 400 MODE_INVALID for invalid mode", async () => {
    const personality = makePersonality()
    await seedPersonality(redis, personality)

    const app = new Hono()
    app.post("/:collection/:tokenId/mode", (c) => handleModeSwitch(c, deps))

    const res = await app.request("/testcol/1/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "turbo" }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("MODE_INVALID")
  })

  it("returns 400 for missing mode field", async () => {
    const personality = makePersonality()
    await seedPersonality(redis, personality)

    const app = new Hono()
    app.post("/:collection/:tokenId/mode", (c) => handleModeSwitch(c, deps))

    const res = await app.request("/testcol/1/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("MODE_INVALID")
  })

  it("returns 404 when personality does not exist", async () => {
    const app = new Hono()
    app.post("/:collection/:tokenId/mode", (c) => handleModeSwitch(c, deps))

    const res = await app.request("/testcol/999/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "brainstorm" }),
    })

    expect(res.status).toBe(404)
    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("PERSONALITY_NOT_FOUND")
  })

  it("returns 400 for legacy_v1 personality", async () => {
    const legacyPersonality = makePersonality({
      compatibility_mode: "legacy_v1",
      signals: null,
    })
    await seedPersonality(redis, legacyPersonality)

    const app = new Hono()
    app.post("/:collection/:tokenId/mode", (c) => handleModeSwitch(c, deps))

    const res = await app.request("/testcol/1/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "brainstorm" }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("INVALID_REQUEST")
  })

  const modes: AgentMode[] = ["default", "brainstorm", "critique", "execute"]

  for (const mode of modes) {
    it(`switches to ${mode} mode successfully`, async () => {
      const personality = makePersonality()
      await seedPersonality(redis, personality)

      const expectedFingerprint = makeDAMPFingerprint(mode)
      mockDeriveDAMP.mockReturnValue(expectedFingerprint)

      const app = new Hono()
      app.post("/:collection/:tokenId/mode", (c) => handleModeSwitch(c, deps))

      const res = await app.request("/testcol/1/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.mode).toBe(mode)
      expect(body.damp).toBeDefined()
      expect(mockDeriveDAMP).toHaveBeenCalledWith(personality.signals, mode)
    })
  }

  it("persists mode in Redis at correct key", async () => {
    const personality = makePersonality()
    await seedPersonality(redis, personality)

    mockDeriveDAMP.mockReturnValue(makeDAMPFingerprint("brainstorm"))

    const app = new Hono()
    app.post("/:collection/:tokenId/mode", (c) => handleModeSwitch(c, deps))

    await app.request("/testcol/1/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "brainstorm" }),
    })

    // Verify Redis persistence
    const persistedMode = await redis.get("damp:mode:testcol:1")
    expect(persistedMode).toBe("brainstorm")
  })

  it("caches dAMP fingerprint for the mode", async () => {
    const personality = makePersonality()
    await seedPersonality(redis, personality)

    const fingerprint = makeDAMPFingerprint("critique")
    mockDeriveDAMP.mockReturnValue(fingerprint)

    const app = new Hono()
    app.post("/:collection/:tokenId/mode", (c) => handleModeSwitch(c, deps))

    await app.request("/testcol/1/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "critique" }),
    })

    // Verify dAMP cache was set
    const cacheKey = "damp:cache:testcol:1:critique"
    const cached = await redis.get(cacheKey)
    expect(cached).not.toBeNull()
    const parsedCached = JSON.parse(cached!)
    expect(parsedCached.mode).toBe("critique")
  })
})

// ---------------------------------------------------------------------------
// Tests: Resolver reads persisted mode (Task 15.2 resolver update)
// ---------------------------------------------------------------------------

describe("resolvePersonalityPrompt — mode-aware", () => {
  let redis: MockRedis

  beforeEach(() => {
    vi.clearAllMocks()
    redis = createMockRedis()

    mockLoadCodexVersion.mockReturnValue({
      version: "0.1.0",
      sha: "test-sha",
      description: "Test codex",
      pinned_at: "2026-02-19T00:00:00Z",
    })
  })

  it("uses default mode when no mode persisted in Redis", async () => {
    const personality = makePersonality()
    await seedPersonality(redis, personality)

    const service = new PersonalityService({ redis, walAppend: () => "wal-id" })

    const result = await resolvePersonalityPrompt(service, "testcol:1", redis)

    expect(result).toContain("<system-personality>")
    expect(result).toContain("</system-personality>")
    // Should NOT have called deriveDAMP since no persisted mode (or mode is "default")
    expect(mockDeriveDAMP).not.toHaveBeenCalled()
  })

  it("uses persisted mode from Redis for dAMP derivation", async () => {
    const personality = makePersonality()
    await seedPersonality(redis, personality)

    // Persist a non-default mode
    await redis.set("damp:mode:testcol:1", "brainstorm")

    const brainstormFingerprint = makeDAMPFingerprint("brainstorm")
    mockDeriveDAMP.mockReturnValue(brainstormFingerprint)

    const service = new PersonalityService({ redis, walAppend: () => "wal-id" })

    const result = await resolvePersonalityPrompt(service, "testcol:1", redis)

    expect(result).toContain("<system-personality>")
    // deriveDAMP should have been called with brainstorm mode
    expect(mockDeriveDAMP).toHaveBeenCalledWith(personality.signals, "brainstorm")
  })

  it("falls back to default when Redis read fails", async () => {
    const personality = makePersonality()
    await seedPersonality(redis, personality)

    // Create a failing Redis for mode lookup
    const failingRedis: RedisCommandClient = {
      ...redis,
      get: vi.fn().mockRejectedValue(new Error("Redis unavailable")),
    } as any

    const service = new PersonalityService({ redis, walAppend: () => "wal-id" })

    const result = await resolvePersonalityPrompt(service, "testcol:1", failingRedis)

    // Should still return a valid prompt (fallback to default mode)
    expect(result).toContain("<system-personality>")
    expect(result).toContain("</system-personality>")
  })

  it("works without redis parameter (backward compatibility)", async () => {
    const personality = makePersonality()
    await seedPersonality(redis, personality)

    const service = new PersonalityService({ redis, walAppend: () => "wal-id" })

    // Call without redis — should use default mode
    const result = await resolvePersonalityPrompt(service, "testcol:1")

    expect(result).toContain("<system-personality>")
    expect(result).toContain("</system-personality>")
  })
})

// ---------------------------------------------------------------------------
// Tests: Rollback Endpoint (Task 15.3)
// ---------------------------------------------------------------------------

describe("handleRollback", () => {
  let redis: MockRedis
  let mockVersionService: {
    createVersion: ReturnType<typeof vi.fn>
    getVersion: ReturnType<typeof vi.fn>
    getHistory: ReturnType<typeof vi.fn>
    getLatest: ReturnType<typeof vi.fn>
    rollback: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.clearAllMocks()
    redis = createMockRedis()

    mockLoadCodexVersion.mockReturnValue({
      version: "0.1.0",
      sha: "test-sha",
      description: "Test codex",
      pinned_at: "2026-02-19T00:00:00Z",
    })
    mockDeriveDAMP.mockReturnValue(makeDAMPFingerprint())

    mockVersionService = {
      createVersion: vi.fn(),
      getVersion: vi.fn(),
      getHistory: vi.fn(),
      getLatest: vi.fn(),
      rollback: vi.fn(),
    }
  })

  it("returns 503 when version service not available", async () => {
    const personality = makePersonality()
    await seedPersonality(redis, personality)

    const { deps } = createTestDeps(redis) // No versionService

    const app = new Hono()
    app.post("/:collection/:tokenId/personality/rollback/:versionId", (c) => handleRollback(c, deps))

    const res = await app.request("/testcol/1/personality/rollback/TARGET_VERSION", {
      method: "POST",
    })

    expect(res.status).toBe(503)
    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("STORAGE_UNAVAILABLE")
  })

  it("returns 404 when personality does not exist", async () => {
    const { deps } = createTestDeps(redis, {
      versionService: mockVersionService as any,
    })

    const app = new Hono()
    app.post("/:collection/:tokenId/personality/rollback/:versionId", (c) => handleRollback(c, deps))

    const res = await app.request("/testcol/999/personality/rollback/TARGET_VERSION", {
      method: "POST",
    })

    expect(res.status).toBe(404)
    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("PERSONALITY_NOT_FOUND")
  })

  it("returns 404 when target version does not exist", async () => {
    const personality = makePersonality()
    await seedPersonality(redis, personality)

    mockVersionService.rollback.mockRejectedValue(
      new Error("Version not found: NONEXISTENT_VERSION for testcol:1"),
    )

    const { deps } = createTestDeps(redis, {
      versionService: mockVersionService as any,
    })

    const app = new Hono()
    app.post("/:collection/:tokenId/personality/rollback/:versionId", (c) => handleRollback(c, deps))

    const res = await app.request("/testcol/1/personality/rollback/NONEXISTENT_VERSION", {
      method: "POST",
    })

    expect(res.status).toBe(404)
    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("VERSION_NOT_FOUND")
  })

  it("rolls back successfully — creates new version with old content", async () => {
    const personality = makePersonality()
    await seedPersonality(redis, personality)

    const targetSignals = makeSignalSnapshot({ archetype: "milady" })
    const targetFingerprint = makeDAMPFingerprint()

    // The version service rollback returns a NEW version with OLD content
    const newVersion: PersonalityVersion = {
      version_id: "ROLLBACK_VERSION_001",
      previous_version_id: "VERSION_001",
      personality_id: "testcol:1",
      signal_snapshot: targetSignals,
      damp_fingerprint: targetFingerprint,
      beauvoir_md: "# OldAgent\n\nOld BEAUVOIR content",
      authored_by: "unknown",
      governance_model: "holder",
      codex_version: "0.1.0",
      compatibility_mode: "signal_v2",
      created_at: Date.now(),
      change_summary: "Rollback to version TARGET_VERSION_001",
    }

    mockVersionService.rollback.mockResolvedValue(newVersion)

    const { deps } = createTestDeps(redis, {
      versionService: mockVersionService as any,
    })

    const app = new Hono()
    app.post("/:collection/:tokenId/personality/rollback/:versionId", (c) => handleRollback(c, deps))

    const res = await app.request("/testcol/1/personality/rollback/TARGET_VERSION_001", {
      method: "POST",
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.rolled_back_to).toBe("TARGET_VERSION_001")
    expect(body.new_version_id).toBe("ROLLBACK_VERSION_001")

    // Verify rollback was called with correct args
    expect(mockVersionService.rollback).toHaveBeenCalledWith(
      "testcol:1",
      "TARGET_VERSION_001",
      "unknown", // wallet_address from context default
    )
  })

  it("rolled-back personality has content matching target version signals", async () => {
    const personality = makePersonality()
    await seedPersonality(redis, personality)

    const targetSignals = makeSignalSnapshot({ archetype: "milady" })
    const targetFingerprint = makeDAMPFingerprint()

    const newVersion: PersonalityVersion = {
      version_id: "ROLLBACK_VERSION_002",
      previous_version_id: "VERSION_001",
      personality_id: "testcol:1",
      signal_snapshot: targetSignals,
      damp_fingerprint: targetFingerprint,
      beauvoir_md: "# RolledBack\n\nContent",
      authored_by: "unknown",
      governance_model: "holder",
      codex_version: "0.1.0",
      compatibility_mode: "signal_v2",
      created_at: Date.now(),
      change_summary: "Rollback to version OLD_VERSION",
    }

    mockVersionService.rollback.mockResolvedValue(newVersion)

    const { deps, service } = createTestDeps(redis, {
      versionService: mockVersionService as any,
    })

    const app = new Hono()
    app.post("/:collection/:tokenId/personality/rollback/:versionId", (c) => handleRollback(c, deps))

    await app.request("/testcol/1/personality/rollback/OLD_VERSION", {
      method: "POST",
    })

    // Verify the personality was updated with rolled-back signals
    const updatedPersonality = await service.getRaw("testcol", "1")
    expect(updatedPersonality).not.toBeNull()
    expect(updatedPersonality!.signals).toBeDefined()
    // The signals should have been updated (archetype changed to milady in target)
    expect(updatedPersonality!.signals!.archetype).toBe("milady")
  })
})
