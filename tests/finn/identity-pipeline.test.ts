// tests/finn/identity-pipeline.test.ts — Sprint 11: Full E2E Pipeline Integration Tests
//
// Exercises the complete signal-to-BEAUVOIR pipeline:
// dAPM derivation wiring, identity graph integration, safety policy injection,
// distinctive dials summary, and resolver composition.

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SignalSnapshot, DAPMFingerprint, DAPMDialId } from "../../src/nft/signal-types.js"
import { DAPM_DIAL_IDS } from "../../src/nft/signal-types.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Mock beauvoir-template (prevents file system access)
// ---------------------------------------------------------------------------

vi.mock("../../src/nft/beauvoir-template.js", () => ({
  generateBeauvoirMd: (name: string) => `# ${name}\n\nGenerated BEAUVOIR.md`,
  DEFAULT_BEAUVOIR_MD: "# Default\n",
}))

// ---------------------------------------------------------------------------
// Mock deriveDAPM (prevents codex data file access)
// ---------------------------------------------------------------------------

const mockDeriveDAPM = vi.fn()

vi.mock("../../src/nft/dapm.js", () => ({
  deriveDAPM: (...args: unknown[]) => mockDeriveDAPM(...args),
  resolveAncestorFamily: () => "hellenic",
  normalizeSwag: () => 0.6,
  deriveAstrologyBlend: () => 0.5,
  clampModeOffset: (v: number) => Math.max(-0.3, Math.min(0.3, v)),
  ANCESTOR_TO_FAMILY: {},
  ANCESTOR_FAMILIES: [],
}))

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { PersonalityService } from "../../src/nft/personality.js"
import type { PersonalityServiceDeps } from "../../src/nft/personality.js"
import { buildSynthesisPrompt } from "../../src/nft/beauvoir-synthesizer.js"
import type { IdentitySubgraph as BeauvoirIdentitySubgraph } from "../../src/nft/beauvoir-synthesizer.js"
import { buildDAPMSummary, buildDistinctiveDialsSummary } from "../../src/nft/personality-resolver.js"
import { getSafetyPolicyText } from "../../src/nft/safety-policy.js"
import { toSynthesisSubgraph } from "../../src/nft/identity-graph.js"
import type { IdentitySubgraph, GraphNode, GraphEdge } from "../../src/nft/identity-graph.js"

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
// Test Fixtures
// ---------------------------------------------------------------------------

function makeMockSignals(): SignalSnapshot {
  return {
    archetype: "freetekno",
    ancestor: "greek_philosopher",
    birthday: "0450-01-15",
    era: "ancient",
    molecule: "psilocybin",
    tarot: { name: "The Fool", number: 0, suit: "major", element: "air" },
    element: "fire",
    swag_rank: "A",
    swag_score: 75,
    sun_sign: "aries",
    moon_sign: "cancer",
    ascending_sign: "libra",
  }
}

function makeMockFingerprint(mode: string = "default"): DAPMFingerprint {
  const dials = {} as Record<DAPMDialId, number>
  for (let i = 0; i < DAPM_DIAL_IDS.length; i++) {
    // Create some variation: most dials near 0.5, a few extreme
    if (i < 3) {
      dials[DAPM_DIAL_IDS[i]] = 0.95 // Very high — distinctive
    } else if (i >= 93) {
      dials[DAPM_DIAL_IDS[i]] = 0.05 // Very low — distinctive
    } else {
      dials[DAPM_DIAL_IDS[i]] = 0.5 + (i % 10) * 0.02 // Near neutral
    }
  }
  return {
    dials,
    mode: mode as DAPMFingerprint["mode"],
    derived_from: "test-sha-v1",
    derived_at: Date.now(),
  }
}

function makeMockIdentitySubgraph(): IdentitySubgraph {
  const nodes: GraphNode[] = [
    { id: "archetype:freetekno", type: "archetype", label: "Freetekno", properties: {} },
    { id: "ancestor:greek_philosopher", type: "ancestor", label: "Greek Philosopher", properties: {} },
    { id: "era:ancient", type: "era", label: "Ancient", properties: {} },
    { id: "cultural:plato", type: "cultural_reference", label: "Platonic Idealism", properties: {} },
    { id: "aesthetic:minimalism", type: "aesthetic_preference", label: "Minimalist Form", properties: {} },
    { id: "philosophy:stoicism", type: "philosophical_foundation", label: "Stoic Ethics", properties: {} },
  ]

  const edges: GraphEdge[] = [
    { source: "archetype:freetekno", target: "ancestor:greek_philosopher", type: "influences", weight: 0.9 },
    { source: "ancestor:greek_philosopher", target: "cultural:plato", type: "cultural_reference", weight: 0.8 },
  ]

  return {
    nodes,
    edges,
    derivedEdges: [],
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      derived_edge_count: 0,
    },
  }
}

// ===========================================================================
// dAPM Pipeline Tests (Task 11.1)
// ===========================================================================

describe("Sprint 11 — dAPM Pipeline", () => {
  let redis: ReturnType<typeof createMockRedis>

  beforeEach(() => {
    redis = createMockRedis()
    mockDeriveDAPM.mockReset()
    mockDeriveDAPM.mockReturnValue(makeMockFingerprint())
  })

  function makeDeps(): PersonalityServiceDeps {
    return {
      redis,
      walAppend: () => "wal-id",
    }
  }

  it("v2 personality creation triggers dAPM derivation", async () => {
    const service = new PersonalityService(makeDeps())
    const signals = makeMockSignals()

    // Create with signals (v2)
    await service.create("col", "1", {
      name: "TestAgent",
      voice: "analytical",
      expertise_domains: ["crypto"],
      signals,
    } as any) // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(mockDeriveDAPM).toHaveBeenCalledTimes(1)
    expect(mockDeriveDAPM).toHaveBeenCalledWith(signals, "default")
  })

  it("v2 personality update re-derives dAPM when signals change", async () => {
    const service = new PersonalityService(makeDeps())

    // First create a legacy personality
    await service.create("col", "1", {
      name: "TestAgent",
      voice: "analytical",
      expertise_domains: [],
    })

    expect(mockDeriveDAPM).not.toHaveBeenCalled()

    // Update with signals — triggers derivation
    const signals = makeMockSignals()
    await service.update("col", "1", {
      signals,
      authored_by: "0xWallet",
    })

    expect(mockDeriveDAPM).toHaveBeenCalledTimes(1)
    expect(mockDeriveDAPM).toHaveBeenCalledWith(signals, "default")
  })

  it("legacy_v1 creation does NOT trigger dAPM derivation", async () => {
    const service = new PersonalityService(makeDeps())

    await service.create("col", "1", {
      name: "LegacyAgent",
      voice: "sage",
      expertise_domains: [],
    })

    expect(mockDeriveDAPM).not.toHaveBeenCalled()
  })

  it("derived DAPMFingerprint has all 96 dials", () => {
    const fingerprint = makeMockFingerprint()
    const dialKeys = Object.keys(fingerprint.dials)
    expect(dialKeys.length).toBe(96)

    for (const dialId of DAPM_DIAL_IDS) {
      expect(fingerprint.dials).toHaveProperty(dialId)
    }
  })

  it("fingerprint stored on personality record after create", async () => {
    const service = new PersonalityService(makeDeps())
    const signals = makeMockSignals()

    await service.create("col", "1", {
      name: "TestAgent",
      voice: "analytical",
      expertise_domains: ["crypto"],
      signals,
    } as any) // eslint-disable-line @typescript-eslint/no-explicit-any

    const stored = JSON.parse(redis._store.get("personality:col:1")!)
    expect(stored.dapm).toBeTruthy()
    expect(stored.dapm.dials).toBeTruthy()
    expect(stored.dapm.mode).toBe("default")
  })

  it("fingerprint stored on personality record after update", async () => {
    const service = new PersonalityService(makeDeps())

    await service.create("col", "1", {
      name: "TestAgent",
      voice: "analytical",
      expertise_domains: [],
    })

    await service.update("col", "1", {
      signals: makeMockSignals(),
    })

    const stored = JSON.parse(redis._store.get("personality:col:1")!)
    expect(stored.dapm).toBeTruthy()
    expect(stored.dapm.dials).toBeTruthy()
  })
})

// ===========================================================================
// Synthesis Pipeline Tests (Tasks 11.2, 11.2a)
// ===========================================================================

describe("Sprint 11 — Synthesis Pipeline", () => {
  const snapshot = makeMockSignals()
  const fingerprint = makeMockFingerprint()

  it("synthesis prompt includes safety policy section", () => {
    const prompt = buildSynthesisPrompt(snapshot, fingerprint)

    expect(prompt).toContain("## SAFETY CONSTRAINTS")
    expect(prompt).toContain("Safety Policy")
    expect(prompt).toContain("SP-1")
    expect(prompt).toContain("SP-2")
    expect(prompt).toContain("SP-3")
  })

  it("synthesis prompt includes cultural references when subgraph available", () => {
    const subgraph: BeauvoirIdentitySubgraph = {
      cultural_references: ["Platonic Idealism", "Socratic Method"],
      aesthetic_notes: ["Minimalist Form"],
      philosophical_lineage: ["Stoic Ethics"],
    }

    const prompt = buildSynthesisPrompt(snapshot, fingerprint, subgraph)

    expect(prompt).toContain("## IDENTITY CONTEXT")
    expect(prompt).toContain("Platonic Idealism")
    expect(prompt).toContain("Socratic Method")
    expect(prompt).toContain("Minimalist Form")
    expect(prompt).toContain("Stoic Ethics")
  })

  it("synthesis prompt handles missing subgraph gracefully", () => {
    const prompt = buildSynthesisPrompt(snapshot, fingerprint, undefined)

    // Should not contain IDENTITY CONTEXT section
    expect(prompt).not.toContain("## IDENTITY CONTEXT")
    // But should still contain other sections
    expect(prompt).toContain("## SIGNAL DATA")
    expect(prompt).toContain("## SAFETY CONSTRAINTS")
  })

  it("buildSynthesisPrompt includes anti-narration AND safety constraints", () => {
    const prompt = buildSynthesisPrompt(snapshot, fingerprint)

    // Anti-narration
    expect(prompt).toContain("## CRITICAL: ANTI-NARRATION CONSTRAINTS")
    expect(prompt).toContain("AN-1:")
    expect(prompt).toContain("AN-6")

    // Safety
    expect(prompt).toContain("## SAFETY CONSTRAINTS")
    expect(prompt).toContain("SP-1")

    // Safety appears AFTER anti-narration
    const anIndex = prompt.indexOf("ANTI-NARRATION CONSTRAINTS")
    const safetyIndex = prompt.indexOf("SAFETY CONSTRAINTS")
    expect(safetyIndex).toBeGreaterThan(anIndex)
  })
})

// ===========================================================================
// Identity Graph Conversion Tests (Task 11.2)
// ===========================================================================

describe("Sprint 11 — toSynthesisSubgraph", () => {
  it("extracts cultural references from subgraph nodes", () => {
    const subgraph = makeMockIdentitySubgraph()
    const result = toSynthesisSubgraph(subgraph)

    expect(result.cultural_references).toContain("Platonic Idealism")
  })

  it("extracts aesthetic notes from subgraph nodes", () => {
    const subgraph = makeMockIdentitySubgraph()
    const result = toSynthesisSubgraph(subgraph)

    expect(result.aesthetic_notes).toContain("Minimalist Form")
  })

  it("extracts philosophical lineage from subgraph nodes", () => {
    const subgraph = makeMockIdentitySubgraph()
    const result = toSynthesisSubgraph(subgraph)

    expect(result.philosophical_lineage).toContain("Stoic Ethics")
  })

  it("returns empty arrays when no matching node types exist", () => {
    const emptySubgraph: IdentitySubgraph = {
      nodes: [
        { id: "archetype:freetekno", type: "archetype", label: "Freetekno", properties: {} },
      ],
      edges: [],
      derivedEdges: [],
      stats: { node_count: 1, edge_count: 0, derived_edge_count: 0 },
    }

    const result = toSynthesisSubgraph(emptySubgraph)

    expect(result.cultural_references).toEqual([])
    expect(result.aesthetic_notes).toEqual([])
    expect(result.philosophical_lineage).toEqual([])
  })
})

// ===========================================================================
// Resolver Pipeline Tests (Tasks 11.2b, 11.3)
// ===========================================================================

describe("Sprint 11 — Resolver Pipeline", () => {
  // We need to test wrapSignalV2Personality indirectly through resolvePersonalityPrompt
  // since it's a private function. We test via the exported functions.

  it("buildDAPMSummary produces category-grouped output", () => {
    const fingerprint = makeMockFingerprint()
    const summary = buildDAPMSummary(fingerprint)

    expect(summary).toContain("Social Warmth")
    expect(summary).toContain("Conversational Style")
    expect(summary).toContain("Assertiveness")
    expect(summary).toContain("Cognitive Style")
  })

  it("buildDistinctiveDialsSummary shows top 5 most distinctive dials", () => {
    const fingerprint = makeMockFingerprint()
    const summary = buildDistinctiveDialsSummary(fingerprint)

    const lines = summary.split("\n")
    expect(lines.length).toBe(5)

    // Each line should be formatted as "- Name: value (Category)"
    for (const line of lines) {
      expect(line).toMatch(/^- .+: \d+\.\d+ \(.+\)$/)
    }
  })

  it("buildDistinctiveDialsSummary prioritizes dials with highest deviation from 0.5", () => {
    const fingerprint = makeMockFingerprint()
    const summary = buildDistinctiveDialsSummary(fingerprint)

    // Our mock has first 3 dials at 0.95 (deviation=0.45) and last 3 at 0.05 (deviation=0.45)
    // These should appear in the top 5
    expect(summary).toContain("0.95")
    expect(summary).toContain("0.05")
  })

  it("getSafetyPolicyText includes all 3 safety rules", () => {
    const text = getSafetyPolicyText()

    expect(text).toContain("SP-1")
    expect(text).toContain("SP-2")
    expect(text).toContain("SP-3")
    expect(text).toContain("Safety Policy")
  })

  it("signal_v2 resolver prompt includes safety policy", async () => {
    const redis = createMockRedis()
    const service = new PersonalityService({ redis, walAppend: () => "wal-id" })

    // Create a signal_v2 personality directly in Redis
    const personality = {
      id: "col:1",
      name: "V2Agent",
      voice: "analytical",
      expertise_domains: [],
      custom_instructions: "",
      beauvoir_md: "# V2Agent\n\nIdentity content.",
      created_at: Date.now(),
      updated_at: Date.now(),
      compatibility_mode: "signal_v2",
      signals: makeMockSignals(),
      dapm: makeMockFingerprint(),
    }
    redis._store.set("personality:col:1", JSON.stringify(personality))

    // Import resolvePersonalityPrompt
    const { resolvePersonalityPrompt } = await import("../../src/nft/personality-resolver.js")
    const prompt = await resolvePersonalityPrompt(service, "col:1")

    expect(prompt).toContain("Safety Constraints")
    expect(prompt).toContain("SP-1")
  })

  it("signal_v2 resolver prompt includes dAPM summary", async () => {
    const redis = createMockRedis()
    const service = new PersonalityService({ redis, walAppend: () => "wal-id" })

    const personality = {
      id: "col:1",
      name: "V2Agent",
      voice: "analytical",
      expertise_domains: [],
      custom_instructions: "",
      beauvoir_md: "# V2Agent\n\nIdentity.",
      created_at: Date.now(),
      updated_at: Date.now(),
      compatibility_mode: "signal_v2",
      signals: makeMockSignals(),
      dapm: makeMockFingerprint(),
    }
    redis._store.set("personality:col:1", JSON.stringify(personality))

    const { resolvePersonalityPrompt } = await import("../../src/nft/personality-resolver.js")
    const prompt = await resolvePersonalityPrompt(service, "col:1")

    expect(prompt).toContain("## Behavioral Calibration (dAPM)")
    expect(prompt).toContain("Social Warmth")
  })

  it("signal_v2 resolver prompt includes distinctive dials", async () => {
    const redis = createMockRedis()
    const service = new PersonalityService({ redis, walAppend: () => "wal-id" })

    const personality = {
      id: "col:1",
      name: "V2Agent",
      voice: "analytical",
      expertise_domains: [],
      custom_instructions: "",
      beauvoir_md: "# V2Agent\n\nIdentity.",
      created_at: Date.now(),
      updated_at: Date.now(),
      compatibility_mode: "signal_v2",
      signals: makeMockSignals(),
      dapm: makeMockFingerprint(),
    }
    redis._store.set("personality:col:1", JSON.stringify(personality))

    const { resolvePersonalityPrompt } = await import("../../src/nft/personality-resolver.js")
    const prompt = await resolvePersonalityPrompt(service, "col:1")

    expect(prompt).toContain("### Most Distinctive Traits")
  })

  it("legacy_v1 resolver prompt does NOT include safety policy", async () => {
    const redis = createMockRedis()
    const service = new PersonalityService({ redis, walAppend: () => "wal-id" })

    const personality = {
      id: "col:1",
      name: "LegacyAgent",
      voice: "sage",
      expertise_domains: [],
      custom_instructions: "",
      beauvoir_md: "# LegacyAgent\n\nOld style.",
      created_at: Date.now(),
      updated_at: Date.now(),
      compatibility_mode: "legacy_v1",
    }
    redis._store.set("personality:col:1", JSON.stringify(personality))

    const { resolvePersonalityPrompt } = await import("../../src/nft/personality-resolver.js")
    const prompt = await resolvePersonalityPrompt(service, "col:1")

    // Legacy uses wrapPersonality, not wrapSignalV2Personality — no safety policy
    expect(prompt).not.toContain("Safety Constraints")
    expect(prompt).not.toContain("SP-1")
  })

  it("legacy_v1 resolver prompt does NOT include dAPM summary", async () => {
    const redis = createMockRedis()
    const service = new PersonalityService({ redis, walAppend: () => "wal-id" })

    const personality = {
      id: "col:1",
      name: "LegacyAgent",
      voice: "sage",
      expertise_domains: [],
      custom_instructions: "",
      beauvoir_md: "# LegacyAgent\n\nOld style.",
      created_at: Date.now(),
      updated_at: Date.now(),
      compatibility_mode: "legacy_v1",
    }
    redis._store.set("personality:col:1", JSON.stringify(personality))

    const { resolvePersonalityPrompt } = await import("../../src/nft/personality-resolver.js")
    const prompt = await resolvePersonalityPrompt(service, "col:1")

    expect(prompt).not.toContain("Behavioral Calibration")
    expect(prompt).not.toContain("Most Distinctive Traits")
  })
})

// ===========================================================================
// Full E2E Test (all components wired together)
// ===========================================================================

describe("Sprint 11 — Full E2E Pipeline", () => {
  beforeEach(() => {
    mockDeriveDAPM.mockReset()
    mockDeriveDAPM.mockReturnValue(makeMockFingerprint())
  })

  it("create v2 -> derive dAPM -> build synthesis prompt -> validate all sections", async () => {
    const redis = createMockRedis()
    const service = new PersonalityService({
      redis,
      walAppend: () => "wal-id",
    })

    const signals = makeMockSignals()

    // Step 1: Create a v2 personality (triggers dAPM derivation)
    await service.create("col", "1", {
      name: "E2EAgent",
      voice: "analytical",
      expertise_domains: ["philosophy"],
      signals,
    } as any) // eslint-disable-line @typescript-eslint/no-explicit-any

    // Verify dAPM was derived
    expect(mockDeriveDAPM).toHaveBeenCalledTimes(1)

    // Step 2: Load the personality to get the fingerprint
    const personality = await service.getRaw("col", "1")
    expect(personality).toBeTruthy()
    expect(personality!.dapm).toBeTruthy()

    // Step 3: Build synthesis prompt with all data
    const subgraph: BeauvoirIdentitySubgraph = {
      cultural_references: ["Socratic Method"],
      aesthetic_notes: ["Geometric Harmony"],
      philosophical_lineage: ["Stoic Ethics"],
    }

    const prompt = buildSynthesisPrompt(
      signals,
      personality!.dapm!,
      subgraph,
      { name: "E2EAgent", expertise_domains: ["philosophy"] },
    )

    // Validate all sections are present
    expect(prompt).toContain("## SIGNAL DATA")
    expect(prompt).toContain("freetekno")
    expect(prompt).toContain("greek_philosopher")
    expect(prompt).toContain("## PERSONALITY DIALS")
    expect(prompt).toContain("## IDENTITY CONTEXT")
    expect(prompt).toContain("Socratic Method")
    expect(prompt).toContain("Geometric Harmony")
    expect(prompt).toContain("Stoic Ethics")
    expect(prompt).toContain("## USER CUSTOMIZATION")
    expect(prompt).toContain("E2EAgent")
    expect(prompt).toContain("## CRITICAL: ANTI-NARRATION CONSTRAINTS")
    expect(prompt).toContain("## SAFETY CONSTRAINTS")
    expect(prompt).toContain("## OUTPUT FORMAT")
  })

  it("resolver composes correct system prompt with all components", async () => {
    const redis = createMockRedis()
    const service = new PersonalityService({
      redis,
      walAppend: () => "wal-id",
    })

    // Create v2 personality in Redis with all data
    const personality = {
      id: "col:1",
      name: "FullAgent",
      voice: "analytical",
      expertise_domains: ["crypto"],
      custom_instructions: "",
      beauvoir_md: "# FullAgent\n\n## Identity\nA thoughtful entity.\n\n## Voice\nCalm and measured.",
      created_at: Date.now(),
      updated_at: Date.now(),
      compatibility_mode: "signal_v2",
      signals: makeMockSignals(),
      dapm: makeMockFingerprint(),
      voice_profile: {
        archetype_voice: "freetekno" as const,
        cultural_voice: "Hellenic philosophical tradition",
        temporal_register: "ancient" as const,
        energy_signature: "fire" as const,
        confidence: 0.75,
      },
    }
    redis._store.set("personality:col:1", JSON.stringify(personality))

    const { resolvePersonalityPrompt } = await import("../../src/nft/personality-resolver.js")
    const prompt = await resolvePersonalityPrompt(service, "col:1")

    // Should be wrapped in system-personality delimiters
    expect(prompt).toContain("<system-personality>")
    expect(prompt).toContain("</system-personality>")

    // Should contain BEAUVOIR identity content
    expect(prompt).toContain("# FullAgent")
    expect(prompt).toContain("A thoughtful entity")

    // Should contain dAPM behavioral calibration
    expect(prompt).toContain("## Behavioral Calibration (dAPM)")
    expect(prompt).toContain("Social Warmth")

    // Should contain distinctive dials
    expect(prompt).toContain("### Most Distinctive Traits")

    // Should contain voice profile
    expect(prompt).toContain("## Voice Profile")
    expect(prompt).toContain("freetekno")
    expect(prompt).toContain("Hellenic philosophical tradition")

    // Should contain safety constraints
    expect(prompt).toContain("## Safety Constraints")
    expect(prompt).toContain("SP-1")
    expect(prompt).toContain("SP-2")
    expect(prompt).toContain("SP-3")
  })
})
