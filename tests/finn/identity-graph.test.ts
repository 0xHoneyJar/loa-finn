// tests/finn/identity-graph.test.ts — Identity Graph Test Suite (Sprint 9 Tasks 9.1-9.5)

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  KnowledgeGraphLoader,
  extractSubgraph,
  resolveCulturalReferences,
  resolveAestheticPreferences,
  resolvePhilosophicalFoundations,
  IdentityGraphCache,
} from "../../src/nft/identity-graph.js"
import type {
  KnowledgeGraph,
  GraphNode,
  GraphEdge,
  IdentitySubgraph,
  DerivedEdge,
  CulturalReference,
  AestheticPreference,
  PhilosophicalFoundation,
  IdentityGraphCacheConfig,
} from "../../src/nft/identity-graph.js"
import { resolveAncestorFamily, ANCESTOR_TO_FAMILY } from "../../src/nft/dapm.js"
import type { SignalSnapshot } from "../../src/nft/signal-types.js"
import { clearArtifactCache } from "../../src/nft/codex-data/loader.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Fixture Loading
// ---------------------------------------------------------------------------

const FIXTURE_PATH = resolve(__dirname, "../fixtures/graph-fixture.json")

function loadFixture(): {
  version: string
  nodes: Array<{ id: string; type: string; label: string; properties: Record<string, unknown> }>
  edges: Array<{ source: string; target: string; type: string; weight: number }>
} {
  const raw = readFileSync(FIXTURE_PATH, "utf-8")
  return JSON.parse(raw)
}

function makeSnapshot(overrides?: Partial<SignalSnapshot>): SignalSnapshot {
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
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function createMockRedis() {
  const store = new Map<string, string>()
  const expiry = new Map<string, number>()
  return {
    _store: store,
    _expiry: expiry,
    async get(key: string) {
      return store.get(key) ?? null
    },
    async set(key: string, value: string, ..._args: (string | number)[]) {
      store.set(key, value)
      return "OK" as const
    },
    async del(...keys: string[]) {
      let n = 0
      for (const k of keys) if (store.delete(k)) n++
      return n
    },
    async incrby(_key: string, _increment: number) {
      return 0
    },
    async incrbyfloat(_key: string, _increment: number) {
      return "0"
    },
    async expire(key: string, seconds: number) {
      expiry.set(key, seconds)
      return 1
    },
    async exists(...keys: string[]) {
      let n = 0
      for (const k of keys) if (store.has(k)) n++
      return n
    },
    async ping() {
      return "PONG"
    },
    async eval() {
      return null as unknown
    },
    async hgetall() {
      return {} as Record<string, string>
    },
    async hincrby() {
      return 0
    },
    async zadd() {
      return 0
    },
    async zpopmin() {
      return [] as string[]
    },
    async zremrangebyscore() {
      return 0
    },
    async zcard() {
      return 0
    },
    async publish() {
      return 0
    },
    async quit() {
      return "OK"
    },
  }
}

// ---------------------------------------------------------------------------
// KnowledgeGraphLoader (Tasks 9.1 + 9.2)
// ---------------------------------------------------------------------------

describe("KnowledgeGraphLoader (Task 9.1 + 9.2)", () => {
  let loader: KnowledgeGraphLoader

  beforeEach(() => {
    loader = new KnowledgeGraphLoader()
  })

  it("loads fixture graph with correct node count", () => {
    const fixture = loadFixture()
    const graph = loader.load(fixture)
    expect(graph.nodes.size).toBe(fixture.nodes.length)
  })

  it("loads fixture graph with correct edge count", () => {
    const fixture = loadFixture()
    const graph = loader.load(fixture)
    expect(graph.edges.length).toBe(fixture.edges.length)
  })

  it("node map has O(1) lookup by id", () => {
    const fixture = loadFixture()
    const graph = loader.load(fixture)

    // Verify known nodes are findable
    const archetypeNode = graph.nodes.get("archetype:freetekno")
    expect(archetypeNode).toBeDefined()
    expect(archetypeNode!.type).toBe("archetype")
    expect(archetypeNode!.label).toBe("Freetekno")

    const ancestorNode = graph.nodes.get("ancestor:greek_philosopher")
    expect(ancestorNode).toBeDefined()
    expect(ancestorNode!.type).toBe("ancestor")
    expect(ancestorNode!.label).toBe("Greek Philosopher")
  })

  it("adjacency list is built correctly (bidirectional)", () => {
    const fixture = loadFixture()
    const graph = loader.load(fixture)

    // Check that ancestor:greek_philosopher has outgoing edges
    const adjGreek = graph.adjacency.get("ancestor:greek_philosopher")
    expect(adjGreek).toBeDefined()
    expect(adjGreek!.length).toBeGreaterThan(0)

    // Check that archetype:freetekno has adjacency entries
    // (from reverse edges of ancestors that belong_to freetekno)
    const adjFreetekno = graph.adjacency.get("archetype:freetekno")
    expect(adjFreetekno).toBeDefined()
    expect(adjFreetekno!.length).toBeGreaterThan(0)
  })

  it("returns cached graph on second load", () => {
    const fixture = loadFixture()
    const graph1 = loader.load(fixture)
    const graph2 = loader.load() // No override — should return cached
    expect(graph1).toBe(graph2) // Same reference
  })

  it("reset() clears the cache", () => {
    const fixture = loadFixture()
    const graph1 = loader.load(fixture)
    loader.reset()

    // Load again with fixture
    const graph2 = loader.load(fixture)
    expect(graph1).not.toBe(graph2) // Different reference
    expect(graph2.nodes.size).toBe(graph1.nodes.size)
  })

  it("all fixture node types are represented", () => {
    const fixture = loadFixture()
    const graph = loader.load(fixture)

    const types = new Set<string>()
    for (const [, node] of graph.nodes) {
      types.add(node.type)
    }

    expect(types.has("archetype")).toBe(true)
    expect(types.has("ancestor")).toBe(true)
    expect(types.has("era")).toBe(true)
    expect(types.has("element")).toBe(true)
    expect(types.has("ancestor_family")).toBe(true)
    expect(types.has("cultural_reference")).toBe(true)
    expect(types.has("aesthetic_preference")).toBe(true)
    expect(types.has("philosophical_foundation")).toBe(true)
  })

  it("loads from registered artifact when no override provided", () => {
    clearArtifactCache()
    const freshLoader = new KnowledgeGraphLoader()
    // This loads from the actual graph.json via the artifact loader
    const graph = freshLoader.load()
    expect(graph.nodes.size).toBeGreaterThan(100) // Full graph has ~500 nodes
    expect(graph.edges.length).toBeGreaterThan(500) // Full graph has ~2000 edges
  })
})

// ---------------------------------------------------------------------------
// Subgraph Extraction (Task 9.3)
// ---------------------------------------------------------------------------

describe("extractSubgraph (Task 9.3)", () => {
  let graph: KnowledgeGraph

  beforeEach(() => {
    const loader = new KnowledgeGraphLoader()
    graph = loader.load(loadFixture())
  })

  it("returns a subset of the full graph", () => {
    const subgraph = extractSubgraph(graph, "freetekno", "greek_philosopher")
    expect(subgraph.nodes.length).toBeGreaterThan(0)
    expect(subgraph.nodes.length).toBeLessThan(graph.nodes.size)
    expect(subgraph.edges.length).toBeGreaterThan(0)
  })

  it("includes the seed archetype and ancestor nodes", () => {
    const subgraph = extractSubgraph(graph, "freetekno", "greek_philosopher")
    const nodeIds = subgraph.nodes.map(n => n.id)
    expect(nodeIds).toContain("archetype:freetekno")
    expect(nodeIds).toContain("ancestor:greek_philosopher")
  })

  it("includes 1-hop neighbors of archetype", () => {
    const subgraph = extractSubgraph(graph, "freetekno", "greek_philosopher")
    const nodeIds = new Set(subgraph.nodes.map(n => n.id))

    // Freetekno has aesthetic preference edges in fixture
    expect(nodeIds.has("aesthetic_preference:diy_aesthetics")).toBe(true)
    expect(nodeIds.has("aesthetic_preference:sound_system_culture")).toBe(true)
  })

  it("includes 1-hop neighbors of ancestor", () => {
    const subgraph = extractSubgraph(graph, "freetekno", "greek_philosopher")
    const nodeIds = new Set(subgraph.nodes.map(n => n.id))

    // Greek philosopher has cultural reference edges in fixture
    expect(nodeIds.has("cultural_reference:socratic_method")).toBe(true)
    expect(nodeIds.has("cultural_reference:platonic_forms")).toBe(true)
  })

  it("includes era and element nodes when signals provided", () => {
    const signals = makeSnapshot()
    const subgraph = extractSubgraph(graph, "freetekno", "greek_philosopher", signals)
    const nodeIds = new Set(subgraph.nodes.map(n => n.id))

    expect(nodeIds.has("era:ancient")).toBe(true)
    expect(nodeIds.has("element:fire")).toBe(true)
  })

  it("includes derived edges marked as codex_table source", () => {
    const signals = makeSnapshot()
    const subgraph = extractSubgraph(graph, "freetekno", "greek_philosopher", signals)

    expect(subgraph.derivedEdges.length).toBeGreaterThan(0)
    for (const de of subgraph.derivedEdges) {
      expect(de.sourceType).toBe("codex_table")
    }
  })

  it("derived edges include molecule->tarot and tarot->element", () => {
    const signals = makeSnapshot()
    const subgraph = extractSubgraph(graph, "freetekno", "greek_philosopher", signals)

    const derivedTypes = subgraph.derivedEdges.map(e => e.type)
    expect(derivedTypes).toContain("molecule_tarot_bijection")
    expect(derivedTypes).toContain("tarot_element_derivation")
  })

  it("stats reflect actual counts", () => {
    const signals = makeSnapshot()
    const subgraph = extractSubgraph(graph, "freetekno", "greek_philosopher", signals)

    expect(subgraph.stats.node_count).toBe(subgraph.nodes.length)
    expect(subgraph.stats.edge_count).toBe(subgraph.edges.length)
    expect(subgraph.stats.derived_edge_count).toBe(subgraph.derivedEdges.length)
  })

  it("edges are deduplicated", () => {
    const subgraph = extractSubgraph(graph, "freetekno", "greek_philosopher")
    const edgeKeys = subgraph.edges.map(e => `${e.source}|${e.target}|${e.type}`)
    const uniqueKeys = new Set(edgeKeys)
    expect(edgeKeys.length).toBe(uniqueKeys.size)
  })

  it("no derived edges when signals not provided", () => {
    const subgraph = extractSubgraph(graph, "freetekno", "greek_philosopher")
    expect(subgraph.derivedEdges.length).toBe(0)
  })

  it("different ancestors produce different subgraphs", () => {
    const sg1 = extractSubgraph(graph, "freetekno", "greek_philosopher")
    const sg2 = extractSubgraph(graph, "freetekno", "cypherpunk")

    const ids1 = new Set(sg1.nodes.map(n => n.id))
    const ids2 = new Set(sg2.nodes.map(n => n.id))

    // Both include the archetype seed node
    expect(ids1.has("archetype:freetekno")).toBe(true)
    expect(ids2.has("archetype:freetekno")).toBe(true)

    // Each includes its own ancestor seed node
    expect(ids1.has("ancestor:greek_philosopher")).toBe(true)
    expect(ids2.has("ancestor:cypherpunk")).toBe(true)

    // Ancestor-specific cultural references differ
    // greek_philosopher has Socratic Method, cypherpunk has Zero-Knowledge Proofs
    expect(ids1.has("cultural_reference:socratic_method")).toBe(true)
    expect(ids2.has("cultural_reference:zero_knowledge_proofs")).toBe(true)
    expect(ids1.has("cultural_reference:zero_knowledge_proofs")).toBe(false)
    expect(ids2.has("cultural_reference:socratic_method")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Cultural Reference Resolution (Task 9.4)
// ---------------------------------------------------------------------------

describe("resolveCulturalReferences (Task 9.4)", () => {
  let graph: KnowledgeGraph

  beforeEach(() => {
    const loader = new KnowledgeGraphLoader()
    graph = loader.load(loadFixture())
  })

  it("resolves cultural references for greek_philosopher", () => {
    const refs = resolveCulturalReferences(graph, "greek_philosopher")
    expect(refs.length).toBe(2) // Socratic Method + Platonic Forms in fixture
    const labels = refs.map(r => r.label)
    expect(labels).toContain("Socratic Method")
    expect(labels).toContain("Platonic Forms")
  })

  it("resolves cultural references for buddhist_monk", () => {
    const refs = resolveCulturalReferences(graph, "buddhist_monk")
    expect(refs.length).toBe(2)
    const labels = refs.map(r => r.label)
    expect(labels).toContain("Four Noble Truths")
    expect(labels).toContain("Mindfulness Practice")
  })

  it("returns empty array for unknown ancestor", () => {
    const refs = resolveCulturalReferences(graph, "nonexistent_ancestor")
    expect(refs).toEqual([])
  })

  it("results are sorted by weight descending", () => {
    const refs = resolveCulturalReferences(graph, "greek_philosopher")
    for (let i = 1; i < refs.length; i++) {
      expect(refs[i - 1].weight).toBeGreaterThanOrEqual(refs[i].weight)
    }
  })

  it("each reference has id, label, and weight", () => {
    const refs = resolveCulturalReferences(graph, "greek_philosopher")
    for (const ref of refs) {
      expect(typeof ref.id).toBe("string")
      expect(ref.id.length).toBeGreaterThan(0)
      expect(typeof ref.label).toBe("string")
      expect(ref.label.length).toBeGreaterThan(0)
      expect(typeof ref.weight).toBe("number")
      expect(ref.weight).toBeGreaterThanOrEqual(0)
      expect(ref.weight).toBeLessThanOrEqual(1)
    }
  })

  it("accepts both prefixed and unprefixed ancestor ids", () => {
    const refs1 = resolveCulturalReferences(graph, "greek_philosopher")
    const refs2 = resolveCulturalReferences(graph, "ancestor:greek_philosopher")
    expect(refs1.length).toBe(refs2.length)
    expect(refs1.map(r => r.id).sort()).toEqual(refs2.map(r => r.id).sort())
  })
})

// ---------------------------------------------------------------------------
// Aesthetic Preference Resolution (Task 9.4)
// ---------------------------------------------------------------------------

describe("resolveAestheticPreferences (Task 9.4)", () => {
  let graph: KnowledgeGraph

  beforeEach(() => {
    const loader = new KnowledgeGraphLoader()
    graph = loader.load(loadFixture())
  })

  it("resolves aesthetic preferences for freetekno", () => {
    const prefs = resolveAestheticPreferences(graph, "freetekno")
    expect(prefs.length).toBe(2) // DIY Aesthetics + Sound System Culture in fixture
    const labels = prefs.map(p => p.label)
    expect(labels).toContain("DIY Aesthetics")
    expect(labels).toContain("Sound System Culture")
  })

  it("resolves aesthetic preferences for milady", () => {
    const prefs = resolveAestheticPreferences(graph, "milady")
    expect(prefs.length).toBe(2)
    const labels = prefs.map(p => p.label)
    expect(labels).toContain("Kawaii Maximalism")
    expect(labels).toContain("Digital Glamour")
  })

  it("returns empty array for unknown archetype", () => {
    const prefs = resolveAestheticPreferences(graph, "nonexistent_archetype")
    expect(prefs).toEqual([])
  })

  it("results are sorted by weight descending", () => {
    const prefs = resolveAestheticPreferences(graph, "freetekno")
    for (let i = 1; i < prefs.length; i++) {
      expect(prefs[i - 1].weight).toBeGreaterThanOrEqual(prefs[i].weight)
    }
  })

  it("all 4 archetypes resolved (on full graph)", () => {
    clearArtifactCache()
    const fullLoader = new KnowledgeGraphLoader()
    const fullGraph = fullLoader.load()

    for (const arch of ["freetekno", "milady", "chicago_detroit", "acidhouse"]) {
      const prefs = resolveAestheticPreferences(fullGraph, arch)
      expect(prefs.length, `no aesthetic prefs for ${arch}`).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Philosophical Foundation Resolution (Task 9.4)
// ---------------------------------------------------------------------------

describe("resolvePhilosophicalFoundations (Task 9.4)", () => {
  let graph: KnowledgeGraph

  beforeEach(() => {
    const loader = new KnowledgeGraphLoader()
    graph = loader.load(loadFixture())
  })

  it("resolves philosophical foundations for ancient era", () => {
    const founds = resolvePhilosophicalFoundations(graph, "ancient")
    expect(founds.length).toBe(2) // Classical Philosophy + Oral Tradition in fixture
    const labels = founds.map(f => f.label)
    expect(labels).toContain("Classical Philosophy")
    expect(labels).toContain("Oral Tradition")
  })

  it("resolves philosophical foundations for contemporary era", () => {
    const founds = resolvePhilosophicalFoundations(graph, "contemporary")
    expect(founds.length).toBe(2)
    const labels = founds.map(f => f.label)
    expect(labels).toContain("Post-Modern Plurality")
    expect(labels).toContain("Digital Consciousness")
  })

  it("returns empty array for unknown era", () => {
    const founds = resolvePhilosophicalFoundations(graph, "nonexistent_era")
    expect(founds).toEqual([])
  })

  it("results are sorted by weight descending", () => {
    const founds = resolvePhilosophicalFoundations(graph, "ancient")
    for (let i = 1; i < founds.length; i++) {
      expect(founds[i - 1].weight).toBeGreaterThanOrEqual(founds[i].weight)
    }
  })
})

// ---------------------------------------------------------------------------
// Redis Cache (Task 9.5)
// ---------------------------------------------------------------------------

describe("IdentityGraphCache (Task 9.5)", () => {
  let mockRedis: ReturnType<typeof createMockRedis>
  let cache: IdentityGraphCache

  beforeEach(() => {
    mockRedis = createMockRedis()
    cache = new IdentityGraphCache({ redis: mockRedis as any })
  })

  it("get returns null for uncached key", async () => {
    const result = await cache.get("v1.0.0", "freetekno", "hellenic")
    expect(result).toBeNull()
  })

  it("set + get round-trips a subgraph", async () => {
    const subgraph: IdentitySubgraph = {
      nodes: [{ id: "archetype:freetekno", type: "archetype", label: "Freetekno", properties: {} }],
      edges: [{ source: "ancestor:greek_philosopher", target: "archetype:freetekno", type: "belongs_to", weight: 0.5 }],
      derivedEdges: [],
      stats: { node_count: 1, edge_count: 1, derived_edge_count: 0 },
    }

    await cache.set("v1.0.0", "freetekno", "hellenic", subgraph)
    const result = await cache.get("v1.0.0", "freetekno", "hellenic")

    expect(result).not.toBeNull()
    expect(result!.nodes.length).toBe(1)
    expect(result!.edges.length).toBe(1)
    expect(result!.stats.node_count).toBe(1)
  })

  it("cache key format: identity:graph:{codex_version}:{archetype}:{ancestor_family}", async () => {
    const subgraph: IdentitySubgraph = {
      nodes: [],
      edges: [],
      derivedEdges: [],
      stats: { node_count: 0, edge_count: 0, derived_edge_count: 0 },
    }

    await cache.set("v1.0.0", "freetekno", "hellenic", subgraph)

    const expectedKey = "identity:graph:v1.0.0:freetekno:hellenic"
    expect(mockRedis._store.has(expectedKey)).toBe(true)
  })

  it("different inputs produce different cache keys", async () => {
    const subgraph: IdentitySubgraph = {
      nodes: [],
      edges: [],
      derivedEdges: [],
      stats: { node_count: 0, edge_count: 0, derived_edge_count: 0 },
    }

    await cache.set("v1.0.0", "freetekno", "hellenic", subgraph)
    await cache.set("v1.0.0", "milady", "dharmic", subgraph)
    await cache.set("v2.0.0", "freetekno", "hellenic", subgraph)

    expect(mockRedis._store.size).toBe(3)
  })

  it("set calls expire with TTL", async () => {
    const subgraph: IdentitySubgraph = {
      nodes: [],
      edges: [],
      derivedEdges: [],
      stats: { node_count: 0, edge_count: 0, derived_edge_count: 0 },
    }

    await cache.set("v1.0.0", "freetekno", "hellenic", subgraph)

    const expectedKey = "identity:graph:v1.0.0:freetekno:hellenic"
    expect(mockRedis._expiry.get(expectedKey)).toBe(86400) // Default 24h
  })

  it("custom TTL is respected", async () => {
    const customCache = new IdentityGraphCache({
      redis: mockRedis as any,
      ttlSeconds: 3600,
    })

    const subgraph: IdentitySubgraph = {
      nodes: [],
      edges: [],
      derivedEdges: [],
      stats: { node_count: 0, edge_count: 0, derived_edge_count: 0 },
    }

    await customCache.set("v1.0.0", "freetekno", "hellenic", subgraph)

    const expectedKey = "identity:graph:v1.0.0:freetekno:hellenic"
    expect(mockRedis._expiry.get(expectedKey)).toBe(3600)
  })

  it("get returns null for invalid JSON in cache", async () => {
    const key = "identity:graph:v1.0.0:freetekno:hellenic"
    mockRedis._store.set(key, "not-valid-json{{{")

    const result = await cache.get("v1.0.0", "freetekno", "hellenic")
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Graph-Aware resolveAncestorFamily (Sprint 9 update to dapm.ts)
// ---------------------------------------------------------------------------

describe("resolveAncestorFamily with graph (Sprint 9)", () => {
  let graph: KnowledgeGraph

  beforeEach(() => {
    const loader = new KnowledgeGraphLoader()
    graph = loader.load(loadFixture())
  })

  it("known ancestors still use table lookup even with graph", () => {
    expect(resolveAncestorFamily("greek_philosopher", graph)).toBe("hellenic")
    expect(resolveAncestorFamily("buddhist_monk", graph)).toBe("dharmic")
    expect(resolveAncestorFamily("cypherpunk", graph)).toBe("techno_modern")
  })

  it("unknown ancestor uses graph edges to find family", () => {
    // quantum_mystic exists only in fixture graph, not in ANCESTOR_TO_FAMILY table
    // It has edges to ancestor_family:techno_modern (0.9) and ancestor_family:mystical (0.6)
    // Should pick techno_modern (highest weight)
    const family = resolveAncestorFamily("quantum_mystic", graph)
    expect(family).toBe("techno_modern")
  })

  it("unknown ancestor without graph falls back to mystical", () => {
    expect(resolveAncestorFamily("quantum_mystic")).toBe("mystical")
    expect(resolveAncestorFamily("quantum_mystic", null)).toBe("mystical")
  })

  it("null graph uses table lookup", () => {
    expect(resolveAncestorFamily("greek_philosopher", null)).toBe("hellenic")
    expect(resolveAncestorFamily("buddhist_monk", null)).toBe("dharmic")
  })

  it("completely unknown ancestor (not in graph either) falls back to mystical", () => {
    expect(resolveAncestorFamily("totally_unknown", graph)).toBe("mystical")
  })

  it("all 33 known ancestors still resolve correctly with graph present", () => {
    for (const [ancestor, expectedFamily] of Object.entries(ANCESTOR_TO_FAMILY)) {
      const result = resolveAncestorFamily(ancestor, graph)
      expect(result, `${ancestor} should be ${expectedFamily}`).toBe(expectedFamily)
    }
  })
})

// ---------------------------------------------------------------------------
// Full Graph Artifact Validation
// ---------------------------------------------------------------------------

describe("Full graph.json artifact", () => {
  it("loads via artifact loader with valid checksum", () => {
    clearArtifactCache()
    const loader = new KnowledgeGraphLoader()
    const graph = loader.load()

    // ~500 nodes, ~2000 edges
    expect(graph.nodes.size).toBeGreaterThanOrEqual(400)
    expect(graph.nodes.size).toBeLessThanOrEqual(600)
    expect(graph.edges.length).toBeGreaterThanOrEqual(1500)
    expect(graph.edges.length).toBeLessThanOrEqual(3000)
  })

  it("contains all 4 archetypes", () => {
    clearArtifactCache()
    const loader = new KnowledgeGraphLoader()
    const graph = loader.load()

    for (const arch of ["freetekno", "milady", "chicago_detroit", "acidhouse"]) {
      expect(graph.nodes.has(`archetype:${arch}`), `missing archetype:${arch}`).toBe(true)
    }
  })

  it("contains all 33 ancestors", () => {
    clearArtifactCache()
    const loader = new KnowledgeGraphLoader()
    const graph = loader.load()

    for (const ancestor of Object.keys(ANCESTOR_TO_FAMILY)) {
      expect(graph.nodes.has(`ancestor:${ancestor}`), `missing ancestor:${ancestor}`).toBe(true)
    }
  })

  it("contains all 5 eras", () => {
    clearArtifactCache()
    const loader = new KnowledgeGraphLoader()
    const graph = loader.load()

    for (const era of ["ancient", "medieval", "early_modern", "modern", "contemporary"]) {
      expect(graph.nodes.has(`era:${era}`), `missing era:${era}`).toBe(true)
    }
  })

  it("contains all 4 elements", () => {
    clearArtifactCache()
    const loader = new KnowledgeGraphLoader()
    const graph = loader.load()

    for (const elem of ["fire", "water", "air", "earth"]) {
      expect(graph.nodes.has(`element:${elem}`), `missing element:${elem}`).toBe(true)
    }
  })

  it("every ancestor has cultural reference edges", () => {
    clearArtifactCache()
    const loader = new KnowledgeGraphLoader()
    const graph = loader.load()

    for (const ancestor of Object.keys(ANCESTOR_TO_FAMILY)) {
      const refs = resolveCulturalReferences(graph, ancestor)
      expect(refs.length, `no cultural refs for ${ancestor}`).toBeGreaterThan(0)
    }
  })

  it("every archetype has aesthetic preference edges", () => {
    clearArtifactCache()
    const loader = new KnowledgeGraphLoader()
    const graph = loader.load()

    for (const arch of ["freetekno", "milady", "chicago_detroit", "acidhouse"]) {
      const prefs = resolveAestheticPreferences(graph, arch)
      expect(prefs.length, `no aesthetic prefs for ${arch}`).toBeGreaterThan(0)
    }
  })

  it("every era has philosophical foundation edges", () => {
    clearArtifactCache()
    const loader = new KnowledgeGraphLoader()
    const graph = loader.load()

    for (const era of ["ancient", "medieval", "early_modern", "modern", "contemporary"]) {
      const founds = resolvePhilosophicalFoundations(graph, era)
      expect(founds.length, `no philosophical foundations for ${era}`).toBeGreaterThan(0)
    }
  })

  it("edge weights are in [0.0, 1.0]", () => {
    clearArtifactCache()
    const loader = new KnowledgeGraphLoader()
    const graph = loader.load()

    for (const edge of graph.edges) {
      expect(edge.weight, `edge ${edge.source}->${edge.target}`).toBeGreaterThanOrEqual(0)
      expect(edge.weight, `edge ${edge.source}->${edge.target}`).toBeLessThanOrEqual(1)
    }
  })
})
