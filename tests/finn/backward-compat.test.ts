// tests/finn/backward-compat.test.ts — Backward Compatibility Tests (Sprint 3 Task 3.5)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { PersonalityService, decodePersonality } from "../../src/nft/personality.js"
import type { PersonalityServiceDeps } from "../../src/nft/personality.js"
import type { NFTPersonality } from "../../src/nft/types.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Mock Redis (minimal key-value)
// ---------------------------------------------------------------------------

function createMockRedis(): RedisCommandClient & { _store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    _store: store,
    async get(key: string) { return store.get(key) ?? null },
    async set(key: string, value: string) { store.set(key, value); return "OK" },
    async del(...keys: string[]) {
      let n = 0
      for (const k of keys) if (store.delete(k)) n++
      return n
    },
    async incrby() { return 0 },
    async incrbyfloat() { return "0" },
    async expire() { return 1 },
    async exists() { return 0 },
    async ping() { return "PONG" },
    async eval() { return null },
    async hgetall() { return {} },
    async hincrby() { return 0 },
    async zadd() { return 1 },
    async zpopmin() { return [] },
    async zremrangebyscore() { return 0 },
    async zcard() { return 0 },
    async publish() { return 0 },
    async quit() { return "OK" },
  }
}

// ---------------------------------------------------------------------------
// Mock beauvoir-template
// ---------------------------------------------------------------------------

vi.mock("../../src/nft/beauvoir-template.js", () => ({
  generateBeauvoirMd: (name: string) => `# ${name}\n\nGenerated BEAUVOIR.md`,
  DEFAULT_BEAUVOIR_MD: "# Default\n",
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Backward Compatibility — decodePersonality()", () => {
  it("maps undefined signals to null", () => {
    const raw: Record<string, unknown> = {
      id: "col:1",
      name: "TestAgent",
      voice: "analytical",
      expertise_domains: [],
      custom_instructions: "",
      beauvoir_md: "# Test",
      created_at: 1000,
      updated_at: 1000,
      // signals deliberately absent (legacy record)
    }

    const decoded = decodePersonality(raw)
    expect(decoded.signals).toBeNull()
  })

  it("maps undefined dapm to null", () => {
    const raw: Record<string, unknown> = {
      id: "col:1",
      name: "TestAgent",
      voice: "analytical",
      expertise_domains: [],
      custom_instructions: "",
      beauvoir_md: "# Test",
      created_at: 1000,
      updated_at: 1000,
    }

    const decoded = decodePersonality(raw)
    expect(decoded.dapm).toBeNull()
  })

  it("maps undefined voice_profile to null", () => {
    const raw: Record<string, unknown> = {
      id: "col:1",
      name: "TestAgent",
      voice: "creative",
      expertise_domains: [],
      custom_instructions: "",
      beauvoir_md: "# Test",
      created_at: 1000,
      updated_at: 1000,
    }

    const decoded = decodePersonality(raw)
    expect(decoded.voice_profile).toBeNull()
  })

  it("maps undefined previous_version_id to null", () => {
    const raw: Record<string, unknown> = {
      id: "col:1",
      name: "TestAgent",
      voice: "sage",
      expertise_domains: [],
      custom_instructions: "",
      beauvoir_md: "# Test",
      created_at: 1000,
      updated_at: 1000,
    }

    const decoded = decodePersonality(raw)
    expect(decoded.previous_version_id).toBeNull()
  })

  it("infers legacy_v1 compatibility_mode when signals absent", () => {
    const raw: Record<string, unknown> = {
      id: "col:1",
      name: "TestAgent",
      voice: "witty",
      expertise_domains: [],
      custom_instructions: "",
      beauvoir_md: "# Test",
      created_at: 1000,
      updated_at: 1000,
    }

    const decoded = decodePersonality(raw)
    expect(decoded.compatibility_mode).toBe("legacy_v1")
  })

  it("infers signal_v2 compatibility_mode when signals present", () => {
    const raw: Record<string, unknown> = {
      id: "col:1",
      name: "TestAgent",
      voice: "analytical",
      expertise_domains: [],
      custom_instructions: "",
      beauvoir_md: "# Test",
      created_at: 1000,
      updated_at: 1000,
      signals: {
        archetype: "freetekno",
        ancestor: "ancestor-1",
        birthday: "1352-06-15",
        era: "medieval",
        molecule: "DMT",
        tarot: { name: "The Fool", number: 0, suit: "major", element: "air" },
        element: "air",
        swag_rank: "S",
        swag_score: 75,
        sun_sign: "aries",
        moon_sign: "cancer",
        ascending_sign: "leo",
      },
    }

    const decoded = decodePersonality(raw)
    expect(decoded.compatibility_mode).toBe("signal_v2")
  })

  it("preserves existing compatibility_mode when present", () => {
    const raw: Record<string, unknown> = {
      id: "col:1",
      name: "TestAgent",
      voice: "analytical",
      expertise_domains: [],
      custom_instructions: "",
      beauvoir_md: "# Test",
      created_at: 1000,
      updated_at: 1000,
      compatibility_mode: "signal_v2",
      signals: null,
    }

    const decoded = decodePersonality(raw)
    // Already set — should not be overridden even though signals is null
    expect(decoded.compatibility_mode).toBe("signal_v2")
  })

  it("defaults governance_model to holder when absent", () => {
    const raw: Record<string, unknown> = {
      id: "col:1",
      name: "TestAgent",
      voice: "analytical",
      expertise_domains: [],
      custom_instructions: "",
      beauvoir_md: "# Test",
      created_at: 1000,
      updated_at: 1000,
    }

    const decoded = decodePersonality(raw)
    expect(decoded.governance_model).toBe("holder")
  })

  it("preserves existing governance_model when present", () => {
    const raw: Record<string, unknown> = {
      id: "col:1",
      name: "TestAgent",
      voice: "analytical",
      expertise_domains: [],
      custom_instructions: "",
      beauvoir_md: "# Test",
      created_at: 1000,
      updated_at: 1000,
      governance_model: "dao",
    }

    const decoded = decodePersonality(raw)
    expect(decoded.governance_model).toBe("dao")
  })

  it("legacy record fully deserializes through decodePersonality", () => {
    // Simulate a v1-era record with no signal fields at all
    const legacyJson = JSON.stringify({
      id: "oldcol:42",
      name: "OldAgent",
      voice: "sage",
      expertise_domains: ["philosophy"],
      custom_instructions: "Be wise.",
      beauvoir_md: "# OldAgent\n\nWise personality.",
      created_at: 1609459200000,
      updated_at: 1609459200000,
    })

    const raw = JSON.parse(legacyJson) as Record<string, unknown>
    const decoded = decodePersonality(raw)

    expect(decoded.id).toBe("oldcol:42")
    expect(decoded.name).toBe("OldAgent")
    expect(decoded.signals).toBeNull()
    expect(decoded.dapm).toBeNull()
    expect(decoded.voice_profile).toBeNull()
    expect(decoded.compatibility_mode).toBe("legacy_v1")
    expect(decoded.governance_model).toBe("holder")
    expect(decoded.previous_version_id).toBeNull()
    // Core fields preserved
    expect(decoded.expertise_domains).toEqual(["philosophy"])
    expect(decoded.custom_instructions).toBe("Be wise.")
  })
})

describe("Backward Compatibility — PersonalityService compatibility_mode", () => {
  let redis: ReturnType<typeof createMockRedis>
  let walEvents: Array<{ op: string; key: string; payload: unknown }>

  beforeEach(() => {
    redis = createMockRedis()
    walEvents = []
  })

  function makeDeps(overrides?: Partial<PersonalityServiceDeps>): PersonalityServiceDeps {
    return {
      redis,
      walAppend: (ns, op, key, payload) => {
        walEvents.push({ op, key, payload })
        return "wal-id"
      },
      ...overrides,
    }
  }

  it("create without signals sets legacy_v1 mode", async () => {
    const service = new PersonalityService(makeDeps())
    await service.create("col", "1", {
      name: "TestAgent",
      voice: "analytical",
      expertise_domains: ["crypto"],
    })

    const stored = JSON.parse(redis._store.get("personality:col:1")!)
    expect(stored.compatibility_mode).toBe("legacy_v1")
  })

  it("create emits personality_create_v2 WAL event", async () => {
    const service = new PersonalityService(makeDeps())
    await service.create("col", "1", {
      name: "TestAgent",
      voice: "analytical",
      expertise_domains: [],
    })

    const v2Events = walEvents.filter(e => e.op === "personality_create_v2")
    expect(v2Events.length).toBe(1)
    expect((v2Events[0].payload as Record<string, unknown>).compatibility_mode).toBe("legacy_v1")
  })

  it("update emits personality_update_v2 WAL event", async () => {
    const service = new PersonalityService(makeDeps())
    await service.create("col", "1", {
      name: "TestAgent",
      voice: "analytical",
      expertise_domains: [],
    })
    walEvents.length = 0 // Clear create events

    await service.update("col", "1", { name: "UpdatedAgent" })

    const v2Events = walEvents.filter(e => e.op === "personality_update_v2")
    expect(v2Events.length).toBe(1)
    expect((v2Events[0].payload as Record<string, unknown>).compatibility_mode).toBe("legacy_v1")
  })

  it("update sets compatibility_mode on personality record", async () => {
    const service = new PersonalityService(makeDeps())
    await service.create("col", "1", {
      name: "TestAgent",
      voice: "analytical",
      expertise_domains: [],
    })

    await service.update("col", "1", { name: "UpdatedAgent" })

    const stored = JSON.parse(redis._store.get("personality:col:1")!)
    expect(stored.compatibility_mode).toBe("legacy_v1")
  })

  it("loadPersonality uses decodePersonality for legacy records", async () => {
    // Insert a pre-v2 record directly (no compatibility_mode field)
    const legacyRecord: Record<string, unknown> = {
      id: "col:legacy",
      name: "LegacyAgent",
      voice: "sage",
      expertise_domains: [],
      custom_instructions: "",
      beauvoir_md: "# Legacy",
      created_at: 1000,
      updated_at: 1000,
    }
    redis._store.set("personality:col:legacy", JSON.stringify(legacyRecord))

    const service = new PersonalityService(makeDeps())
    const result = await service.get("col", "legacy")

    // Should not throw — decodePersonality handles missing fields
    expect(result).toBeTruthy()
    expect(result!.name).toBe("LegacyAgent")
  })
})
