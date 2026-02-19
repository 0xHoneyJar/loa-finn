// tests/finn/backward-compat.test.ts — Backward Compatibility Tests (Sprint 3 Task 3.5 + Sprint 4 Task 4.5)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { PersonalityService, decodePersonality } from "../../src/nft/personality.js"
import type { PersonalityServiceDeps } from "../../src/nft/personality.js"
import type { NFTPersonality } from "../../src/nft/types.js"
import type { SignalSnapshot } from "../../src/nft/signal-types.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"
import { getLegacyDAMPOffsets, LEGACY_VOICE_OFFSETS } from "../../src/nft/damp-tables.js"
import { DAMP_DIAL_IDS } from "../../src/nft/signal-types.js"
import type { VoiceType } from "../../src/nft/types.js"

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

  it("maps undefined damp to null", () => {
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
    expect(decoded.damp).toBeNull()
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
    expect(decoded.damp).toBeNull()
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

// ===========================================================================
// Sprint 4 Task 4.5: Extended backward compatibility tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Helper: mock signal snapshot
// ---------------------------------------------------------------------------

function makeMockSignals(): SignalSnapshot {
  return {
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
  }
}

// ---------------------------------------------------------------------------
// Task 4.5: Legacy API response shape validation
// ---------------------------------------------------------------------------

describe("Sprint 4 — Legacy API response shape", () => {
  let redis: ReturnType<typeof createMockRedis>

  beforeEach(() => {
    redis = createMockRedis()
  })

  function makeDeps(): PersonalityServiceDeps {
    return {
      redis,
      walAppend: () => "wal-id",
    }
  }

  it("legacy create response includes null signal-era fields", async () => {
    const service = new PersonalityService(makeDeps())
    const result = await service.create("col", "1", {
      name: "LegacyAgent",
      voice: "analytical",
      expertise_domains: ["crypto"],
    })

    expect(result.signals).toBeNull()
    expect(result.damp).toBeNull()
    expect(result.voice_profile).toBeNull()
    expect(result.compatibility_mode).toBe("legacy_v1")
    expect(result.version_id).toBeNull()
  })

  it("legacy get response includes null signal-era fields", async () => {
    const service = new PersonalityService(makeDeps())
    await service.create("col", "1", {
      name: "LegacyAgent",
      voice: "creative",
      expertise_domains: [],
    })

    const result = await service.get("col", "1")
    expect(result).toBeTruthy()
    expect(result!.signals).toBeNull()
    expect(result!.damp).toBeNull()
    expect(result!.voice_profile).toBeNull()
    expect(result!.compatibility_mode).toBe("legacy_v1")
    expect(result!.version_id).toBeNull()
  })

  it("legacy update response includes null signal-era fields", async () => {
    const service = new PersonalityService(makeDeps())
    await service.create("col", "1", {
      name: "LegacyAgent",
      voice: "witty",
      expertise_domains: [],
    })

    const result = await service.update("col", "1", { name: "Updated" })
    expect(result.signals).toBeNull()
    expect(result.damp).toBeNull()
    expect(result.voice_profile).toBeNull()
    expect(result.compatibility_mode).toBe("legacy_v1")
    expect(result.version_id).toBeNull()
  })

  it("preserves core v1 response fields unchanged", async () => {
    const service = new PersonalityService(makeDeps())
    const result = await service.create("col", "1", {
      name: "CoreAgent",
      voice: "sage",
      expertise_domains: ["philosophy", "history"],
      custom_instructions: "Be thoughtful.",
    })

    expect(result.id).toBe("col:1")
    expect(result.name).toBe("CoreAgent")
    expect(result.voice).toBe("sage")
    expect(result.expertise_domains).toEqual(["philosophy", "history"])
    expect(result.custom_instructions).toBe("Be thoughtful.")
    expect(typeof result.created_at).toBe("number")
    expect(typeof result.updated_at).toBe("number")
  })
})

// ---------------------------------------------------------------------------
// Task 4.5: VoiceType-to-offset mapping tests
// ---------------------------------------------------------------------------

describe("Sprint 4 — getLegacyDAMPOffsets()", () => {
  const voices: VoiceType[] = ["analytical", "creative", "witty", "sage"]

  it("returns exactly 96 dials for each voice", () => {
    for (const voice of voices) {
      const offsets = getLegacyDAMPOffsets(voice)
      const keys = Object.keys(offsets)
      expect(keys.length).toBe(96)
    }
  })

  it("all dial values are in [0.0, 1.0] range", () => {
    for (const voice of voices) {
      const offsets = getLegacyDAMPOffsets(voice)
      for (const [dialId, value] of Object.entries(offsets)) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    }
  })

  it("non-specified dials are at 0.5 (neutral)", () => {
    const offsets = getLegacyDAMPOffsets("analytical")
    // Dials NOT in the analytical offset map should be 0.5
    const specifiedDials = new Set(Object.keys(LEGACY_VOICE_OFFSETS.analytical))
    for (const dialId of DAMP_DIAL_IDS) {
      if (!specifiedDials.has(dialId)) {
        expect(offsets[dialId]).toBe(0.5)
      }
    }
  })

  it("analytical: cs_formality is offset +0.3 from neutral", () => {
    const offsets = getLegacyDAMPOffsets("analytical")
    expect(offsets.cs_formality).toBeCloseTo(0.8, 5)
  })

  it("analytical: cs_directness is offset +0.2 from neutral", () => {
    const offsets = getLegacyDAMPOffsets("analytical")
    expect(offsets.cs_directness).toBeCloseTo(0.7, 5)
  })

  it("creative: cs_metaphor_density is offset +0.3 from neutral", () => {
    const offsets = getLegacyDAMPOffsets("creative")
    expect(offsets.cs_metaphor_density).toBeCloseTo(0.8, 5)
  })

  it("creative: cs_narrative_tendency is offset +0.3 from neutral", () => {
    const offsets = getLegacyDAMPOffsets("creative")
    expect(offsets.cs_narrative_tendency).toBeCloseTo(0.8, 5)
  })

  it("witty: cs_turn_taking is offset +0.4 from neutral", () => {
    const offsets = getLegacyDAMPOffsets("witty")
    expect(offsets.cs_turn_taking).toBeCloseTo(0.9, 5)
  })

  it("sage: et_mood_stability is offset +0.3 from neutral", () => {
    const offsets = getLegacyDAMPOffsets("sage")
    expect(offsets.et_mood_stability).toBeCloseTo(0.8, 5)
  })

  it("sage: et_empathic_resonance is offset +0.2 from neutral", () => {
    const offsets = getLegacyDAMPOffsets("sage")
    expect(offsets.et_empathic_resonance).toBeCloseTo(0.7, 5)
  })

  it("all 96 DAMP_DIAL_IDS are present in output", () => {
    for (const voice of voices) {
      const offsets = getLegacyDAMPOffsets(voice)
      for (const dialId of DAMP_DIAL_IDS) {
        expect(offsets).toHaveProperty(dialId)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Task 4.5: Auto-upgrade flow tests
// ---------------------------------------------------------------------------

describe("Sprint 4 — Signal-V2 auto-upgrade on update", () => {
  let redis: ReturnType<typeof createMockRedis>
  let walEvents: Array<{ op: string; key: string; payload: unknown }>

  beforeEach(() => {
    redis = createMockRedis()
    walEvents = []
  })

  function makeDeps(): PersonalityServiceDeps {
    return {
      redis,
      walAppend: (_ns, op, key, payload) => {
        walEvents.push({ op, key, payload })
        return "wal-id"
      },
    }
  }

  it("update with signals upgrades legacy_v1 to signal_v2", async () => {
    const service = new PersonalityService(makeDeps())
    await service.create("col", "1", {
      name: "LegacyAgent",
      voice: "analytical",
      expertise_domains: [],
    })

    // Verify starts as legacy_v1
    const stored1 = JSON.parse(redis._store.get("personality:col:1")!)
    expect(stored1.compatibility_mode).toBe("legacy_v1")
    expect(stored1.signals).toBeUndefined()

    // Update with signals data
    const signals = makeMockSignals()
    await service.update("col", "1", {
      signals,
      authored_by: "0xWallet123",
    })

    const stored2 = JSON.parse(redis._store.get("personality:col:1")!)
    expect(stored2.compatibility_mode).toBe("signal_v2")
    expect(stored2.signals).toBeTruthy()
    expect(stored2.signals.archetype).toBe("freetekno")
  })

  it("upgrade emits personality_upgrade_to_v2 WAL event", async () => {
    const service = new PersonalityService(makeDeps())
    await service.create("col", "1", {
      name: "LegacyAgent",
      voice: "analytical",
      expertise_domains: [],
    })
    walEvents.length = 0

    await service.update("col", "1", {
      signals: makeMockSignals(),
      authored_by: "0xWallet123",
    })

    const upgradeEvents = walEvents.filter(e => e.op === "personality_upgrade_to_v2")
    expect(upgradeEvents.length).toBe(1)
    const payload = upgradeEvents[0].payload as Record<string, unknown>
    expect(payload.from).toBe("legacy_v1")
    expect(payload.to).toBe("signal_v2")
    expect(payload.authored_by).toBe("0xWallet123")
  })

  it("upgrade is irreversible — update without signals keeps signal_v2", async () => {
    const service = new PersonalityService(makeDeps())
    await service.create("col", "1", {
      name: "LegacyAgent",
      voice: "analytical",
      expertise_domains: [],
    })

    // Upgrade to signal_v2
    await service.update("col", "1", { signals: makeMockSignals() })

    // Subsequent update without signals keeps signal_v2
    await service.update("col", "1", { name: "StillV2" })

    const stored = JSON.parse(redis._store.get("personality:col:1")!)
    expect(stored.compatibility_mode).toBe("signal_v2")
    expect(stored.signals).toBeTruthy()
  })

  it("upgrade response includes signal_v2 fields", async () => {
    const service = new PersonalityService(makeDeps())
    await service.create("col", "1", {
      name: "LegacyAgent",
      voice: "analytical",
      expertise_domains: [],
    })

    const result = await service.update("col", "1", {
      signals: makeMockSignals(),
    })

    expect(result.compatibility_mode).toBe("signal_v2")
    expect(result.signals).toBeTruthy()
    expect(result.signals!.archetype).toBe("freetekno")
  })

  it("no regression: update without signals stays legacy_v1", async () => {
    const service = new PersonalityService(makeDeps())
    await service.create("col", "1", {
      name: "LegacyAgent",
      voice: "analytical",
      expertise_domains: [],
    })

    await service.update("col", "1", { name: "StillLegacy" })

    const stored = JSON.parse(redis._store.get("personality:col:1")!)
    expect(stored.compatibility_mode).toBe("legacy_v1")
    expect(stored.signals).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Task 4.5: No regression on existing CRUD
// ---------------------------------------------------------------------------

describe("Sprint 4 — CRUD no-regression", () => {
  let redis: ReturnType<typeof createMockRedis>

  beforeEach(() => {
    redis = createMockRedis()
  })

  function makeDeps(): PersonalityServiceDeps {
    return {
      redis,
      walAppend: () => "wal-id",
    }
  }

  it("create → get → update round-trip works", async () => {
    const service = new PersonalityService(makeDeps())

    const created = await service.create("col", "1", {
      name: "RoundTrip",
      voice: "creative",
      expertise_domains: ["art"],
      custom_instructions: "Be creative.",
    })
    expect(created.id).toBe("col:1")

    const fetched = await service.get("col", "1")
    expect(fetched).toBeTruthy()
    expect(fetched!.name).toBe("RoundTrip")
    expect(fetched!.voice).toBe("creative")

    const updated = await service.update("col", "1", { name: "Evolved" })
    expect(updated.name).toBe("Evolved")
    expect(updated.voice).toBe("creative")
    expect(updated.expertise_domains).toEqual(["art"])
  })

  it("get returns null for nonexistent personality", async () => {
    const service = new PersonalityService(makeDeps())
    const result = await service.get("col", "nonexistent")
    expect(result).toBeNull()
  })

  it("update throws PERSONALITY_NOT_FOUND for nonexistent personality", async () => {
    const service = new PersonalityService(makeDeps())
    await expect(
      service.update("col", "nonexistent", { name: "Ghost" }),
    ).rejects.toThrow("No personality found")
  })

  it("create throws PERSONALITY_EXISTS for duplicate", async () => {
    const service = new PersonalityService(makeDeps())
    await service.create("col", "1", {
      name: "First",
      voice: "analytical",
      expertise_domains: [],
    })

    await expect(
      service.create("col", "1", {
        name: "Second",
        voice: "sage",
        expertise_domains: [],
      }),
    ).rejects.toThrow("already exists")
  })
})
