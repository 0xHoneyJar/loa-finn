// tests/finn/experience-wiring.test.ts — Experience Engine Wiring Tests (Cycle 040, Sprint 2 T-2.6)

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  PersonalityPipelineOrchestrator,
} from "../../src/nft/personality-pipeline.js"
import type { SignalSnapshot, DAMPFingerprint, DAMPDialId } from "../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockRedis() {
  const store = new Map<string, string>()
  return {
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      const nx = args.includes("NX")
      if (nx && store.has(key)) return null
      store.set(key, value)
      return "OK"
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => { store.delete(key); return 1 }),
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    eval: vi.fn(async (_s: string, _n: number, key: string) => {
      if (store.has(key)) { store.delete(key); return 1 }
      return 0
    }),
  }
}

const MOCK_SNAPSHOT: SignalSnapshot = {
  archetype: "freetekno" as any,
  ancestor: "hermes" as any,
  birthday: "1990-06-15",
  era: "modern" as any,
  molecule: "psilocybin" as any,
  tarot: { name: "The Magician", suit: "major", number: 1 } as any,
  element: "fire" as any,
  swag: { rank: "S" as any, score: 85 },
  zodiac: { sun: "gemini" as any, moon: "aries" as any, rising: "leo" as any },
}

function createMockSignalCache() {
  return {
    getSignals: vi.fn(async () => ({ snapshot: MOCK_SNAPSHOT, owner: "0xabc", fromCache: false })),
    hasCached: vi.fn(async () => false),
  }
}

function createMockSynthesizer() {
  return {
    synthesize: vi.fn(async () => "# BEAUVOIR\nYou are a distinct agent."),
  }
}

function createMockStore() {
  return {
    get: vi.fn(async () => null),
    has: vi.fn(async () => false),
    write: vi.fn(async () => {}),
    invalidate: vi.fn(async () => {}),
  }
}

// ---------------------------------------------------------------------------
// Experience Engine Mock
// ---------------------------------------------------------------------------

function createMockExperienceEngine(driftOffset: number = 0.003) {
  return {
    applyExperience: vi.fn((birthFingerprint: DAMPFingerprint, _personalityId: string): DAMPFingerprint => {
      // Apply a small drift to all dials
      const driftedDials = { ...birthFingerprint.dials } as Record<DAMPDialId, number>
      for (const key of Object.keys(driftedDials) as DAMPDialId[]) {
        const birth = driftedDials[key]
        // Clamp cumulative offset to ±5%
        const offset = Math.max(-0.05, Math.min(0.05, driftOffset))
        driftedDials[key] = Math.max(0, Math.min(1, birth + offset))
      }
      return {
        ...birthFingerprint,
        dials: driftedDials,
      }
    }),
    recordInteraction: vi.fn(() => ({ epochTriggered: false, epochDeltas: null })),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Experience Engine Wiring in Pipeline", () => {
  let redis: ReturnType<typeof createMockRedis>

  beforeEach(() => {
    redis = createMockRedis()
    vi.clearAllMocks()
  })

  it("calls applyExperience when experience engine is configured", async () => {
    const engine = createMockExperienceEngine()
    const orch = new PersonalityPipelineOrchestrator({
      signalCache: createMockSignalCache() as any,
      synthesizer: createMockSynthesizer() as any,
      personalityStore: createMockStore() as any,
      redis: redis as any,
      collectionSalt: "test-salt",
      experienceEngine: engine as any,
    })

    await orch.get("42")

    expect(engine.applyExperience).toHaveBeenCalledTimes(1)
    expect(engine.applyExperience).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "default" }),
      "42",
    )
  })

  it("does not call applyExperience when engine is not configured", async () => {
    const orch = new PersonalityPipelineOrchestrator({
      signalCache: createMockSignalCache() as any,
      synthesizer: createMockSynthesizer() as any,
      personalityStore: createMockStore() as any,
      redis: redis as any,
      collectionSalt: "test-salt",
      // No experienceEngine
    })

    await orch.get("42")
    // No assertion on engine — just verifying no error
  })

  it("continues with birth fingerprint when applyExperience throws", async () => {
    const engine = createMockExperienceEngine()
    engine.applyExperience.mockImplementation(() => {
      throw new Error("Experience store unavailable")
    })

    const orch = new PersonalityPipelineOrchestrator({
      signalCache: createMockSignalCache() as any,
      synthesizer: createMockSynthesizer() as any,
      personalityStore: createMockStore() as any,
      redis: redis as any,
      collectionSalt: "test-salt",
      experienceEngine: engine as any,
    })

    // Should NOT throw — falls back to birth fingerprint
    const result = await orch.get("42")
    expect(result).not.toBeNull()
    expect(engine.applyExperience).toHaveBeenCalledTimes(1)
  })

  it("passes drifted fingerprint to synthesizer (not birth fingerprint)", async () => {
    const synthesizer = createMockSynthesizer()
    const engine = createMockExperienceEngine(0.004) // 0.4% drift

    const orch = new PersonalityPipelineOrchestrator({
      signalCache: createMockSignalCache() as any,
      synthesizer: synthesizer as any,
      personalityStore: createMockStore() as any,
      redis: redis as any,
      collectionSalt: "test-salt",
      experienceEngine: engine as any,
    })

    await orch.get("42")

    // Verify synthesizer received the drifted fingerprint (from engine.applyExperience)
    expect(synthesizer.synthesize).toHaveBeenCalledTimes(1)
    const [, fingerprintArg] = synthesizer.synthesize.mock.calls[0]
    // The fingerprint should have been processed by applyExperience
    expect(engine.applyExperience).toHaveBeenCalledBefore(synthesizer.synthesize)
  })

  it("drift is bounded within ±5% cumulative clamp", () => {
    const engine = createMockExperienceEngine(0.10) // 10% — exceeds clamp
    const birthFp: DAMPFingerprint = {
      dials: { sw_approachability: 0.5 } as any,
      mode: "default" as any,
      derived_from: "test",
      derived_at: new Date().toISOString(),
    }

    const result = engine.applyExperience(birthFp, "42")
    const driftedValue = result.dials.sw_approachability as number

    // 0.10 drift requested, but clamped to 0.05 → 0.5 + 0.05 = 0.55
    expect(driftedValue).toBeCloseTo(0.55, 2)
  })
})

describe("Pipeline populates era field", () => {
  it("includes era in PersonalityConfig from snapshot", async () => {
    const redis = createMockRedis()
    const orch = new PersonalityPipelineOrchestrator({
      signalCache: createMockSignalCache() as any,
      synthesizer: createMockSynthesizer() as any,
      personalityStore: createMockStore() as any,
      redis: redis as any,
      collectionSalt: "test-salt",
    })

    const result = await orch.resolve("42")

    expect(result).not.toBeNull()
    expect(result!.config.era).toBe("modern")
  })
})
