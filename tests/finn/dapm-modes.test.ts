// tests/finn/dapm-modes.test.ts — dAPM Mode Override & Cache Test Suite (Sprint 8 Task 8.4)

import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  deriveDAPM,
  clampModeOffset,
} from "../../src/nft/dapm.js"
import {
  getDAPMTables,
  resetDAPMTablesCache,
} from "../../src/nft/dapm-tables.js"
import { clearArtifactCache } from "../../src/nft/codex-data/loader.js"
import { DAPM_DIAL_IDS } from "../../src/nft/signal-types.js"
import type {
  SignalSnapshot,
  AgentMode,
  DAPMDialId,
} from "../../src/nft/signal-types.js"
import { PersonalityService } from "../../src/nft/personality.js"
import type { PersonalityServiceDeps } from "../../src/nft/personality.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const MOCK_SNAPSHOT: SignalSnapshot = {
  archetype: "freetekno",
  ancestor: "greek_philosopher",
  birthday: "1352-06-15",
  era: "medieval",
  molecule: "psilocybin",
  tarot: { name: "The Moon", number: 18, suit: "major", element: "water" },
  element: "water",
  swag_rank: "S",
  swag_score: 72,
  sun_sign: "scorpio",
  moon_sign: "pisces",
  ascending_sign: "cancer",
}

// ---------------------------------------------------------------------------
// Mock Redis (key-value with TTL tracking)
// ---------------------------------------------------------------------------

function createMockRedis(): RedisCommandClient & {
  _store: Map<string, string>
  _ttls: Map<string, number>
  _delCalls: string[][]
} {
  const store = new Map<string, string>()
  const ttls = new Map<string, number>()
  const delCalls: string[][] = []
  return {
    _store: store,
    _ttls: ttls,
    _delCalls: delCalls,
    async get(key: string) { return store.get(key) ?? null },
    async set(key: string, value: string, ...args: (string | number)[]) {
      store.set(key, value)
      // Track EX TTL
      const exIdx = args.indexOf("EX")
      if (exIdx !== -1 && exIdx + 1 < args.length) {
        ttls.set(key, Number(args[exIdx + 1]))
      }
      return "OK"
    },
    async del(...keys: string[]) {
      delCalls.push(keys)
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
// Mock beauvoir-template (needed for PersonalityService)
// ---------------------------------------------------------------------------

vi.mock("../../src/nft/beauvoir-template.js", () => ({
  generateBeauvoirMd: (name: string) => `# ${name}\n\nGenerated BEAUVOIR.md`,
  DEFAULT_BEAUVOIR_MD: "# Default\n",
}))

// ---------------------------------------------------------------------------
// Mode Override Tests
// ---------------------------------------------------------------------------

describe("dAPM Mode Overrides (Sprint 8 Task 8.1)", () => {
  beforeEach(() => {
    clearArtifactCache()
    resetDAPMTablesCache()
  })

  it("brainstorm mode shifts creativity dials upward", () => {
    const fpDefault = deriveDAPM(MOCK_SNAPSHOT, "default")
    const fpBrainstorm = deriveDAPM(MOCK_SNAPSHOT, "brainstorm")

    // Creativity dials should be higher in brainstorm mode
    expect(fpBrainstorm.dials.cr_divergent_thinking).toBeGreaterThan(fpDefault.dials.cr_divergent_thinking)
    expect(fpBrainstorm.dials.cr_originality_drive).toBeGreaterThan(fpDefault.dials.cr_originality_drive)
    expect(fpBrainstorm.dials.ep_speculation_comfort).toBeGreaterThan(fpDefault.dials.ep_speculation_comfort)
  })

  it("critique mode shifts epistemic dials upward", () => {
    const fpDefault = deriveDAPM(MOCK_SNAPSHOT, "default")
    const fpCritique = deriveDAPM(MOCK_SNAPSHOT, "critique")

    // Epistemic / convergence dials should be higher in critique mode
    expect(fpCritique.dials.ep_evidence_threshold).toBeGreaterThan(fpDefault.dials.ep_evidence_threshold)
    expect(fpCritique.dials.cv_completeness_need).toBeGreaterThan(fpDefault.dials.cv_completeness_need)
  })

  it("execute mode shifts convergence dials upward", () => {
    const fpDefault = deriveDAPM(MOCK_SNAPSHOT, "default")
    const fpExecute = deriveDAPM(MOCK_SNAPSHOT, "execute")

    // Convergence dials should be higher in execute mode
    expect(fpExecute.dials.cv_closure_drive).toBeGreaterThan(fpDefault.dials.cv_closure_drive)
    expect(fpExecute.dials.cv_feasibility_weight).toBeGreaterThan(fpDefault.dials.cv_feasibility_weight)
    expect(fpExecute.dials.cv_scope_discipline).toBeGreaterThan(fpDefault.dials.cv_scope_discipline)
  })

  it("default mode produces no mode offset effect", () => {
    const tables = getDAPMTables()
    const defaultDeltas = tables.mode_deltas["default"]
    expect(defaultDeltas).toBeDefined()
    expect(Object.keys(defaultDeltas).length).toBe(0)
  })

  it("each mode produces measurably different dial values from default", () => {
    const fpDefault = deriveDAPM(MOCK_SNAPSHOT, "default")
    const modes: AgentMode[] = ["brainstorm", "critique", "execute"]

    for (const mode of modes) {
      const fp = deriveDAPM(MOCK_SNAPSHOT, mode)
      let differCount = 0
      for (const dialId of DAPM_DIAL_IDS) {
        if (Math.abs(fp.dials[dialId] - fpDefault.dials[dialId]) > 0.0001) {
          differCount++
        }
      }
      expect(differCount, `${mode} should differ from default on multiple dials`).toBeGreaterThan(5)
    }
  })

  it("mode_deltas values in tables are all within [-0.3, +0.3]", () => {
    const tables = getDAPMTables()
    for (const mode of ["brainstorm", "critique", "execute", "default"]) {
      const deltas = tables.mode_deltas[mode]
      for (const [dialId, value] of Object.entries(deltas)) {
        expect(
          value,
          `mode_deltas.${mode}.${dialId} = ${value} exceeds [-0.3, +0.3]`,
        ).toBeGreaterThanOrEqual(-0.3)
        expect(
          value,
          `mode_deltas.${mode}.${dialId} = ${value} exceeds [-0.3, +0.3]`,
        ).toBeLessThanOrEqual(0.3)
      }
    }
  })

  it("brainstorm mode contains required dial offsets", () => {
    const tables = getDAPMTables()
    const brainstorm = tables.mode_deltas["brainstorm"]
    expect(brainstorm["cr_divergent_thinking" as DAPMDialId]).toBe(0.3)
    expect(brainstorm["cr_originality_drive" as DAPMDialId]).toBe(0.25)
    expect(brainstorm["ep_speculation_comfort" as DAPMDialId]).toBe(0.25)
  })

  it("critique mode contains required dial offsets", () => {
    const tables = getDAPMTables()
    const critique = tables.mode_deltas["critique"]
    expect(critique["ep_evidence_threshold" as DAPMDialId]).toBe(0.3)
    expect(critique["cv_completeness_need" as DAPMDialId]).toBe(0.2)
  })

  it("execute mode contains required dial offsets", () => {
    const tables = getDAPMTables()
    const execute = tables.mode_deltas["execute"]
    expect(execute["cv_closure_drive" as DAPMDialId]).toBe(0.3)
    expect(execute["cv_feasibility_weight" as DAPMDialId]).toBe(0.3)
    expect(execute["cv_scope_discipline" as DAPMDialId]).toBe(0.3)
  })
})

// ---------------------------------------------------------------------------
// Mode Offset Capping Tests
// ---------------------------------------------------------------------------

describe("clampModeOffset (Sprint 8 Task 8.1)", () => {
  it("passes through values within [-0.3, +0.3]", () => {
    expect(clampModeOffset(0)).toBe(0)
    expect(clampModeOffset(0.15)).toBe(0.15)
    expect(clampModeOffset(-0.15)).toBe(-0.15)
    expect(clampModeOffset(0.3)).toBe(0.3)
    expect(clampModeOffset(-0.3)).toBe(-0.3)
  })

  it("caps values above +0.3", () => {
    expect(clampModeOffset(0.5)).toBe(0.3)
    expect(clampModeOffset(1.0)).toBe(0.3)
    expect(clampModeOffset(0.31)).toBe(0.3)
  })

  it("caps values below -0.3", () => {
    expect(clampModeOffset(-0.5)).toBe(-0.3)
    expect(clampModeOffset(-1.0)).toBe(-0.3)
    expect(clampModeOffset(-0.31)).toBe(-0.3)
  })

  it("handles zero correctly", () => {
    expect(clampModeOffset(0)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// dAPM Mode Cache Tests (Sprint 8 Task 8.3)
// ---------------------------------------------------------------------------

describe("dAPM Mode Cache (Sprint 8 Task 8.3)", () => {
  let redis: ReturnType<typeof createMockRedis>
  let service: PersonalityService

  beforeEach(() => {
    redis = createMockRedis()
    const deps: PersonalityServiceDeps = {
      redis,
      walAppend: () => "wal-id",
    }
    service = new PersonalityService(deps)
  })

  it("cache key includes mode", async () => {
    const fingerprint = deriveDAPM(MOCK_SNAPSHOT, "brainstorm")
    await service.setDAPMCached("bears", "42", "brainstorm", fingerprint)

    expect(redis._store.has("dapm:cache:bears:42:brainstorm")).toBe(true)
    expect(redis._store.has("dapm:cache:bears:42:default")).toBe(false)
  })

  it("different modes are cached independently", async () => {
    const fpBrainstorm = deriveDAPM(MOCK_SNAPSHOT, "brainstorm")
    const fpCritique = deriveDAPM(MOCK_SNAPSHOT, "critique")

    await service.setDAPMCached("bears", "42", "brainstorm", fpBrainstorm)
    await service.setDAPMCached("bears", "42", "critique", fpCritique)

    const cachedBrainstorm = await service.getDAPMCached("bears", "42", "brainstorm")
    const cachedCritique = await service.getDAPMCached("bears", "42", "critique")

    expect(cachedBrainstorm).not.toBeNull()
    expect(cachedCritique).not.toBeNull()
    expect(cachedBrainstorm!.mode).toBe("brainstorm")
    expect(cachedCritique!.mode).toBe("critique")
  })

  it("cache hit returns stored fingerprint", async () => {
    const fingerprint = deriveDAPM(MOCK_SNAPSHOT, "execute")
    await service.setDAPMCached("bears", "42", "execute", fingerprint)

    const cached = await service.getDAPMCached("bears", "42", "execute")
    expect(cached).not.toBeNull()
    expect(cached!.mode).toBe("execute")
    expect(cached!.dials.cv_closure_drive).toBe(fingerprint.dials.cv_closure_drive)
    // Verify all 96 dials match
    for (const dialId of DAPM_DIAL_IDS) {
      expect(cached!.dials[dialId]).toBe(fingerprint.dials[dialId])
    }
  })

  it("cache miss returns null", async () => {
    const cached = await service.getDAPMCached("bears", "42", "default")
    expect(cached).toBeNull()
  })

  it("cache stores with 1h TTL", async () => {
    const fingerprint = deriveDAPM(MOCK_SNAPSHOT, "default")
    await service.setDAPMCached("bears", "42", "default", fingerprint)

    const ttl = redis._ttls.get("dapm:cache:bears:42:default")
    expect(ttl).toBe(3600)
  })

  it("invalidateDAPMCache deletes all 4 mode variants", async () => {
    // Pre-populate cache for all modes
    for (const mode of ["default", "brainstorm", "critique", "execute"] as AgentMode[]) {
      const fp = deriveDAPM(MOCK_SNAPSHOT, mode)
      await service.setDAPMCached("bears", "42", mode, fp)
    }

    // Verify all are cached
    expect(redis._store.has("dapm:cache:bears:42:default")).toBe(true)
    expect(redis._store.has("dapm:cache:bears:42:brainstorm")).toBe(true)
    expect(redis._store.has("dapm:cache:bears:42:critique")).toBe(true)
    expect(redis._store.has("dapm:cache:bears:42:execute")).toBe(true)

    // Invalidate
    await service.invalidateDAPMCache("bears", "42")

    // Verify all are gone
    expect(redis._store.has("dapm:cache:bears:42:default")).toBe(false)
    expect(redis._store.has("dapm:cache:bears:42:brainstorm")).toBe(false)
    expect(redis._store.has("dapm:cache:bears:42:critique")).toBe(false)
    expect(redis._store.has("dapm:cache:bears:42:execute")).toBe(false)
  })

  it("update() invalidates dAPM cache for the updated NFT", async () => {
    // Create a personality first
    await service.create("bears", "42", {
      name: "TestBear",
      voice: "analytical",
      expertise_domains: ["testing"],
    })

    // Pre-populate dAPM cache
    const fp = deriveDAPM(MOCK_SNAPSHOT, "brainstorm")
    await service.setDAPMCached("bears", "42", "brainstorm", fp)
    expect(redis._store.has("dapm:cache:bears:42:brainstorm")).toBe(true)

    // Update personality
    await service.update("bears", "42", { name: "UpdatedBear" })

    // dAPM cache should be invalidated
    expect(redis._store.has("dapm:cache:bears:42:brainstorm")).toBe(false)
  })

  it("cache hit avoids re-derivation (pattern test)", async () => {
    // Derive and cache
    const fingerprint = deriveDAPM(MOCK_SNAPSHOT, "default")
    await service.setDAPMCached("bears", "42", "default", fingerprint)

    // Retrieve from cache — this is the pattern that avoids re-derivation
    const cached = await service.getDAPMCached("bears", "42", "default")
    expect(cached).not.toBeNull()

    // Cached fingerprint should be equivalent to derived one
    expect(cached!.mode).toBe(fingerprint.mode)
    expect(cached!.derived_from).toBe(fingerprint.derived_from)
    for (const dialId of DAPM_DIAL_IDS) {
      expect(cached!.dials[dialId]).toBe(fingerprint.dials[dialId])
    }
  })
})
