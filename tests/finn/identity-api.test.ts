// tests/finn/identity-api.test.ts — Identity Read API Tests (Sprint 10 Task 10.4)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import { PersonalityService, registerIdentityReadRoutes } from "../../src/nft/personality.js"
import type { PersonalityServiceDeps, IdentityReadDeps } from "../../src/nft/personality.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"
import type { NFTPersonality } from "../../src/nft/types.js"
import type { SignalSnapshot, DAPMFingerprint, DAPMDialId } from "../../src/nft/signal-types.js"
import { DAPM_DIAL_IDS } from "../../src/nft/signal-types.js"

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
// Mock deriveDAPM (avoids loading codex data files from filesystem)
// ---------------------------------------------------------------------------

const mockDeriveDAPM = vi.fn()

vi.mock("../../src/nft/dapm.js", () => ({
  deriveDAPM: (...args: unknown[]) => mockDeriveDAPM(...args),
  resolveAncestorFamily: () => "hellenic",
  normalizeSwag: () => 0.5,
  deriveAstrologyBlend: () => 0.5,
  clampModeOffset: (v: number) => Math.max(-0.3, Math.min(0.3, v)),
  ANCESTOR_TO_FAMILY: {},
  ANCESTOR_FAMILIES: [],
}))

// ---------------------------------------------------------------------------
// Mock identity-graph (avoid filesystem codex loading)
// ---------------------------------------------------------------------------

const mockGraphLoad = vi.fn()
const mockExtractSubgraph = vi.fn()

vi.mock("../../src/nft/identity-graph.js", () => ({
  KnowledgeGraphLoader: class {
    load = mockGraphLoad
    reset = vi.fn()
  },
  extractSubgraph: (...args: unknown[]) => mockExtractSubgraph(...args),
  IdentityGraphCache: class {
    async get() { return null }
    async set() {}
  },
}))

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeDials(value = 0.5): Record<DAPMDialId, number> {
  const dials = {} as Record<DAPMDialId, number>
  for (const id of DAPM_DIAL_IDS) dials[id] = value
  return dials
}

function makeSignalSnapshot(): SignalSnapshot {
  return {
    archetype: "freetekno",
    ancestor: "greek_philosopher",
    birthday: "1352-06-15",
    era: "medieval",
    molecule: "dmt",
    tarot: { name: "The Fool", number: 0, suit: "major", element: "air" },
    element: "air",
    swag_rank: "S",
    swag_score: 75,
    sun_sign: "aries",
    moon_sign: "cancer",
    ascending_sign: "leo",
  }
}

function makeDAPMFingerprint(mode = "default"): DAPMFingerprint {
  return {
    dials: makeDials(0.55),
    mode: mode as DAPMFingerprint["mode"],
    derived_from: "test-sha",
    derived_at: Date.now(),
  }
}

function makeLegacyPersonality(): NFTPersonality {
  return {
    id: "testcol:1",
    name: "LegacyAgent",
    voice: "analytical",
    expertise_domains: ["math"],
    custom_instructions: "",
    beauvoir_md: "# LegacyAgent\n\nGenerated BEAUVOIR.md",
    created_at: Date.now(),
    updated_at: Date.now(),
    compatibility_mode: "legacy_v1",
    signals: null,
    dapm: null,
    governance_model: "holder",
  }
}

function makeSignalV2Personality(): NFTPersonality {
  return {
    id: "testcol:2",
    name: "SignalAgent",
    voice: "creative",
    expertise_domains: ["art"],
    custom_instructions: "",
    beauvoir_md: "# SignalAgent\n\nGenerated BEAUVOIR.md",
    created_at: Date.now(),
    updated_at: Date.now(),
    compatibility_mode: "signal_v2",
    signals: makeSignalSnapshot(),
    dapm: makeDAPMFingerprint(),
    governance_model: "holder",
  }
}

// ---------------------------------------------------------------------------
// Test Setup
// ---------------------------------------------------------------------------

function createTestApp(): {
  app: Hono
  redis: ReturnType<typeof createMockRedis>
  service: PersonalityService
} {
  const redis = createMockRedis()
  const deps: PersonalityServiceDeps = {
    redis,
    walAppend: () => "wal-id",
  }
  const service = new PersonalityService(deps)

  const identityDeps: IdentityReadDeps = {
    service,
    // graphLoader is optional; we provide a mocked one for signal_v2 tests
  }

  const app = new Hono()
  registerIdentityReadRoutes(app, identityDeps)

  return { app, redis, service }
}

function createTestAppWithGraph(): {
  app: Hono
  redis: ReturnType<typeof createMockRedis>
  service: PersonalityService
} {
  const redis = createMockRedis()
  const deps: PersonalityServiceDeps = {
    redis,
    walAppend: () => "wal-id",
  }
  const service = new PersonalityService(deps)

  // Create a mock graph loader object matching KnowledgeGraphLoader interface
  const graphLoader = {
    load: mockGraphLoad,
    reset: vi.fn(),
  }

  const identityDeps: IdentityReadDeps = {
    service,
    graphLoader: graphLoader as unknown as import("../../src/nft/identity-graph.js").KnowledgeGraphLoader,
  }

  const app = new Hono()
  registerIdentityReadRoutes(app, identityDeps)

  return { app, redis, service }
}

/** Seed a personality directly into the mock Redis store */
function seedPersonality(redis: ReturnType<typeof createMockRedis>, personality: NFTPersonality): void {
  redis._store.set(`personality:${personality.id}`, JSON.stringify(personality))
}

// ---------------------------------------------------------------------------
// Tests: Identity Graph Endpoint
// ---------------------------------------------------------------------------

describe("Identity Read API — GET /identity-graph", () => {
  beforeEach(() => {
    mockGraphLoad.mockReset()
    mockExtractSubgraph.mockReset()
    mockDeriveDAPM.mockReset()
  })

  it("returns 404 for non-existent personality", async () => {
    const { app } = createTestApp()

    const res = await app.request("/testcol/999/identity-graph")
    expect(res.status).toBe(404)

    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("PERSONALITY_NOT_FOUND")
  })

  it("returns minimal response for legacy_v1 personality", async () => {
    const { app, redis } = createTestApp()
    seedPersonality(redis, makeLegacyPersonality())

    const res = await app.request("/testcol/1/identity-graph")
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    const nodes = body.nodes as Array<Record<string, unknown>>
    const edges = body.edges as Array<unknown>
    const stats = body.stats as Record<string, unknown>

    expect(nodes).toHaveLength(1)
    expect(nodes[0].type).toBe("personality")
    expect(nodes[0].label).toBe("LegacyAgent")
    expect(edges).toHaveLength(0)
    expect(stats.node_count).toBe(1)
    expect(stats.edge_count).toBe(0)
    expect(stats.primary_archetype).toBe("unknown")
    expect(stats.era).toBe("unknown")
  })

  it("returns nodes/edges/stats for signal_v2 personality with graph loader", async () => {
    const { app, redis } = createTestAppWithGraph()
    seedPersonality(redis, makeSignalV2Personality())

    // Mock graph load returns a fake graph object
    const mockGraph = { nodes: new Map(), edges: [], adjacency: new Map() }
    mockGraphLoad.mockReturnValue(mockGraph)

    // Mock extractSubgraph returns a subgraph
    mockExtractSubgraph.mockReturnValue({
      nodes: [
        { id: "archetype:freetekno", type: "archetype", label: "Freetekno", properties: {} },
        { id: "ancestor:greek_philosopher", type: "ancestor", label: "Greek Philosopher", properties: {} },
        { id: "era:medieval", type: "era", label: "Medieval", properties: {} },
      ],
      edges: [
        { source: "archetype:freetekno", target: "era:medieval", type: "temporal_context", weight: 0.7 },
      ],
      derivedEdges: [
        { source: "molecule:dmt", target: "tarot:the_fool", type: "molecule_tarot_bijection", weight: 1.0, sourceType: "codex_table" },
      ],
      stats: { node_count: 3, edge_count: 1, derived_edge_count: 1 },
    })

    const res = await app.request("/testcol/2/identity-graph")
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    const nodes = body.nodes as Array<Record<string, unknown>>
    const edges = body.edges as Array<Record<string, unknown>>
    const stats = body.stats as Record<string, unknown>

    // Verify nodes are mapped with group and weight
    expect(nodes).toHaveLength(3)
    expect(nodes[0].id).toBe("archetype:freetekno")
    expect(nodes[0].group).toBe("archetype")
    expect(nodes[0].weight).toBe(1.0)
    expect(nodes[1].group).toBe("lineage")
    expect(nodes[2].group).toBe("temporal")

    // Verify edges include both graph edges and derived edges
    expect(edges).toHaveLength(2)
    expect(edges[0].type).toBe("temporal_context")
    expect(edges[1].type).toBe("molecule_tarot_bijection")

    // Verify stats
    expect(stats.node_count).toBe(3)
    expect(stats.edge_count).toBe(2)
    expect(stats.primary_archetype).toBe("freetekno")
    expect(stats.era).toBe("medieval")
  })

  it("returns simplified response when no graph loader is provided", async () => {
    // Use the test app WITHOUT graph loader
    const { app, redis } = createTestApp()
    seedPersonality(redis, makeSignalV2Personality())

    const res = await app.request("/testcol/2/identity-graph")
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    const nodes = body.nodes as Array<Record<string, unknown>>
    const stats = body.stats as Record<string, unknown>

    // Should return metadata nodes only (personality, archetype, era)
    expect(nodes.length).toBeGreaterThanOrEqual(1)
    expect(stats.primary_archetype).toBe("freetekno")
    expect(stats.era).toBe("medieval")
  })
})

// ---------------------------------------------------------------------------
// Tests: Signals Endpoint
// ---------------------------------------------------------------------------

describe("Identity Read API — GET /signals", () => {
  it("returns 404 for non-existent personality", async () => {
    const { app } = createTestApp()

    const res = await app.request("/testcol/999/signals")
    expect(res.status).toBe(404)

    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("PERSONALITY_NOT_FOUND")
  })

  it("returns null signals for legacy_v1 personality", async () => {
    const { app, redis } = createTestApp()
    seedPersonality(redis, makeLegacyPersonality())

    const res = await app.request("/testcol/1/signals")
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    expect(body.signals).toBeNull()
  })

  it("returns SignalSnapshot for signal_v2 personality", async () => {
    const { app, redis } = createTestApp()
    seedPersonality(redis, makeSignalV2Personality())

    const res = await app.request("/testcol/2/signals")
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    const signals = body.signals as Record<string, unknown>

    expect(signals).not.toBeNull()
    expect(signals.archetype).toBe("freetekno")
    expect(signals.ancestor).toBe("greek_philosopher")
    expect(signals.era).toBe("medieval")
    expect(signals.element).toBe("air")
    expect(signals.swag_rank).toBe("S")
    expect(signals.sun_sign).toBe("aries")
  })
})

// ---------------------------------------------------------------------------
// Tests: dAPM Endpoint
// ---------------------------------------------------------------------------

describe("Identity Read API — GET /dapm", () => {
  beforeEach(() => {
    mockDeriveDAPM.mockReset()
  })

  it("returns 404 for non-existent personality", async () => {
    const { app } = createTestApp()

    const res = await app.request("/testcol/999/dapm")
    expect(res.status).toBe(404)

    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("PERSONALITY_NOT_FOUND")
  })

  it("returns null dapm for legacy_v1 personality", async () => {
    const { app, redis } = createTestApp()
    seedPersonality(redis, makeLegacyPersonality())

    const res = await app.request("/testcol/1/dapm")
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    expect(body.dapm).toBeNull()
  })

  it("returns DAPMFingerprint for signal_v2 personality", async () => {
    const { app, redis } = createTestApp()
    seedPersonality(redis, makeSignalV2Personality())

    const res = await app.request("/testcol/2/dapm")
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    const dapm = body.dapm as Record<string, unknown>

    expect(dapm).not.toBeNull()
    expect(dapm.mode).toBe("default")
    expect(dapm.dials).toBeDefined()
    expect(dapm.derived_from).toBe("test-sha")
  })

  it("returns default fingerprint with no mode query", async () => {
    const { app, redis } = createTestApp()
    seedPersonality(redis, makeSignalV2Personality())

    const res = await app.request("/testcol/2/dapm")
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    const dapm = body.dapm as Record<string, unknown>

    // Should return stored fingerprint (mode: "default")
    expect(dapm.mode).toBe("default")
  })

  it("returns 400 MODE_INVALID for invalid mode", async () => {
    const { app, redis } = createTestApp()
    seedPersonality(redis, makeSignalV2Personality())

    const res = await app.request("/testcol/2/dapm?mode=invalid")
    expect(res.status).toBe(400)

    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe("MODE_INVALID")
  })

  it("returns brainstorm fingerprint with ?mode=brainstorm", async () => {
    const { app, redis } = createTestApp()
    seedPersonality(redis, makeSignalV2Personality())

    const brainstormFingerprint = makeDAPMFingerprint("brainstorm")
    mockDeriveDAPM.mockReturnValue(brainstormFingerprint)

    const res = await app.request("/testcol/2/dapm?mode=brainstorm")
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    const dapm = body.dapm as Record<string, unknown>

    expect(dapm.mode).toBe("brainstorm")
    expect(mockDeriveDAPM).toHaveBeenCalledWith(
      expect.objectContaining({ archetype: "freetekno" }),
      "brainstorm",
    )
  })

  it("returns critique fingerprint with ?mode=critique", async () => {
    const { app, redis } = createTestApp()
    seedPersonality(redis, makeSignalV2Personality())

    const critiqueFingerprint = makeDAPMFingerprint("critique")
    mockDeriveDAPM.mockReturnValue(critiqueFingerprint)

    const res = await app.request("/testcol/2/dapm?mode=critique")
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    const dapm = body.dapm as Record<string, unknown>

    expect(dapm.mode).toBe("critique")
    expect(mockDeriveDAPM).toHaveBeenCalledWith(
      expect.objectContaining({ archetype: "freetekno" }),
      "critique",
    )
  })

  it("returns execute fingerprint with ?mode=execute", async () => {
    const { app, redis } = createTestApp()
    seedPersonality(redis, makeSignalV2Personality())

    const executeFingerprint = makeDAPMFingerprint("execute")
    mockDeriveDAPM.mockReturnValue(executeFingerprint)

    const res = await app.request("/testcol/2/dapm?mode=execute")
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    const dapm = body.dapm as Record<string, unknown>

    expect(dapm.mode).toBe("execute")
    expect(mockDeriveDAPM).toHaveBeenCalledWith(
      expect.objectContaining({ archetype: "freetekno" }),
      "execute",
    )
  })

  it("returns default fingerprint with ?mode=default", async () => {
    const { app, redis } = createTestApp()
    seedPersonality(redis, makeSignalV2Personality())

    const defaultFingerprint = makeDAPMFingerprint("default")
    mockDeriveDAPM.mockReturnValue(defaultFingerprint)

    const res = await app.request("/testcol/2/dapm?mode=default")
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    const dapm = body.dapm as Record<string, unknown>

    expect(dapm.mode).toBe("default")
  })

  it("derives with default mode when no stored fingerprint and no mode param", async () => {
    const { app, redis } = createTestApp()

    // Create a signal_v2 personality WITHOUT a stored dapm fingerprint
    const personality = makeSignalV2Personality()
    personality.dapm = null
    seedPersonality(redis, personality)

    const defaultFingerprint = makeDAPMFingerprint("default")
    mockDeriveDAPM.mockReturnValue(defaultFingerprint)

    const res = await app.request("/testcol/2/dapm")
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    const dapm = body.dapm as Record<string, unknown>

    expect(dapm).not.toBeNull()
    expect(dapm.mode).toBe("default")
    expect(mockDeriveDAPM).toHaveBeenCalledWith(
      expect.objectContaining({ archetype: "freetekno" }),
      "default",
    )
  })
})

// ---------------------------------------------------------------------------
// Tests: Route Registration
// ---------------------------------------------------------------------------

describe("Identity Read API — Route Registration", () => {
  it("registerIdentityReadRoutes adds 3 GET routes", async () => {
    const { app, redis } = createTestApp()
    seedPersonality(redis, makeLegacyPersonality())

    // All three endpoints should respond with 200 for existing personality
    const graphRes = await app.request("/testcol/1/identity-graph")
    expect(graphRes.status).toBe(200)

    const signalsRes = await app.request("/testcol/1/signals")
    expect(signalsRes.status).toBe(200)

    const dapmRes = await app.request("/testcol/1/dapm")
    expect(dapmRes.status).toBe(200)
  })

  it("unregistered routes return 404", async () => {
    const { app } = createTestApp()

    const res = await app.request("/testcol/1/nonexistent")
    expect(res.status).toBe(404)
  })
})
