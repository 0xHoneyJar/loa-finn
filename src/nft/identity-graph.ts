// src/nft/identity-graph.ts — Knowledge Graph Integration (SDD Sprint 9, Tasks 9.1-9.5)
//
// Loads the mibera-codex knowledge graph, extracts identity subgraphs for NFT
// signal snapshots, resolves cultural references / aesthetic preferences /
// philosophical foundations, and caches results in Redis.

import type { RedisCommandClient } from "../hounfour/redis/client.js"
import type { SignalSnapshot, Archetype, Era, Element } from "./signal-types.js"
import { loadArtifact } from "./codex-data/loader.js"

// ---------------------------------------------------------------------------
// Types (Task 9.1)
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string
  type: string
  label: string
  properties: Record<string, unknown>
}

export interface GraphEdge {
  source: string
  target: string
  type: string
  weight: number
}

export interface KnowledgeGraph {
  nodes: Map<string, GraphNode>
  edges: GraphEdge[]
  adjacency: Map<string, GraphEdge[]> // source -> outgoing edges
}

export interface IdentitySubgraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  derivedEdges: DerivedEdge[]
  stats: {
    node_count: number
    edge_count: number
    derived_edge_count: number
  }
}

export interface DerivedEdge {
  source: string
  target: string
  type: string
  weight: number
  sourceType: "codex_table" // Always "codex_table" for derived edges
}

export interface CulturalReference {
  id: string
  label: string
  weight: number
}

export interface AestheticPreference {
  id: string
  label: string
  weight: number
}

export interface PhilosophicalFoundation {
  id: string
  label: string
  weight: number
}

// ---------------------------------------------------------------------------
// Raw graph JSON shape (for loadArtifact)
// ---------------------------------------------------------------------------

interface RawGraphData {
  version: string
  nodes: Array<{
    id: string
    type: string
    label: string
    properties: Record<string, unknown>
  }>
  edges: Array<{
    source: string
    target: string
    type: string
    weight: number
  }>
}

// ---------------------------------------------------------------------------
// KnowledgeGraphLoader (Task 9.1 + 9.2)
// ---------------------------------------------------------------------------

export class KnowledgeGraphLoader {
  private graph: KnowledgeGraph | null = null

  /**
   * Load graph from registered artifact. Builds node map + adjacency list.
   * Can also load from a provided raw object (for testing with fixtures).
   */
  load(rawOverride?: RawGraphData): KnowledgeGraph {
    if (this.graph) return this.graph

    const raw = rawOverride ?? loadArtifact<RawGraphData>("knowledge-graph").data

    // Build node map (O(1) lookup by id)
    const nodes = new Map<string, GraphNode>()
    for (const node of raw.nodes) {
      nodes.set(node.id, node)
    }

    // Build adjacency list (bidirectional)
    const adjacency = new Map<string, GraphEdge[]>()
    for (const edge of raw.edges) {
      // Forward direction
      const forward = adjacency.get(edge.source) ?? []
      forward.push(edge)
      adjacency.set(edge.source, forward)

      // Reverse direction (with swapped source/target)
      const reverse = adjacency.get(edge.target) ?? []
      reverse.push({ ...edge, source: edge.target, target: edge.source })
      adjacency.set(edge.target, reverse)
    }

    this.graph = { nodes, edges: raw.edges, adjacency }
    return this.graph
  }

  /** Clear cached graph (for testing) */
  reset(): void {
    this.graph = null
  }
}

// ---------------------------------------------------------------------------
// Subgraph Extraction (Task 9.3)
// ---------------------------------------------------------------------------

// Tarot suit -> element mapping for derived edges
const SUIT_TO_ELEMENT: Record<string, Element> = {
  wands: "fire",
  cups: "water",
  swords: "air",
  pentacles: "earth",
}

/**
 * Extract identity subgraph for a specific NFT's signals.
 * Returns only relevant nodes/edges plus derived edges from codex tables.
 * Extraction is O(degree) of the seed nodes — typically < 10ms.
 */
export function extractSubgraph(
  graph: KnowledgeGraph,
  archetype: Archetype,
  ancestor: string,
  signals?: SignalSnapshot | null,
): IdentitySubgraph {
  const collectedNodeIds = new Set<string>()
  const collectedEdges: GraphEdge[] = []
  const derivedEdges: DerivedEdge[] = []

  // Seed nodes: archetype + ancestor
  const archetypeId = `archetype:${archetype}`
  const ancestorId = `ancestor:${ancestor}`
  collectedNodeIds.add(archetypeId)
  collectedNodeIds.add(ancestorId)

  // Collect 1-hop neighbors for archetype
  collectNeighbors(graph, archetypeId, collectedNodeIds, collectedEdges)

  // Collect 1-hop neighbors for ancestor
  collectNeighbors(graph, ancestorId, collectedNodeIds, collectedEdges)

  // Add era and element nodes if signals provided
  if (signals) {
    const eraId = `era:${signals.era}`
    collectedNodeIds.add(eraId)
    collectNeighbors(graph, eraId, collectedNodeIds, collectedEdges)

    const elementId = `element:${signals.element}`
    collectedNodeIds.add(elementId)
    collectNeighbors(graph, elementId, collectedNodeIds, collectedEdges)

    // Create derived edges from codex tables
    // molecule -> tarot (from molecule-tarot-bijection)
    if (signals.molecule && signals.tarot) {
      const moleculeId = `molecule:${signals.molecule}`
      collectedNodeIds.add(moleculeId)

      derivedEdges.push({
        source: moleculeId,
        target: `tarot:${signals.tarot.name.toLowerCase().replace(/\s+/g, "_")}`,
        type: "molecule_tarot_bijection",
        weight: 1.0,
        sourceType: "codex_table",
      })

      // tarot -> element (from tarot suit)
      const tarotElement = signals.tarot.suit === "major"
        ? signals.element
        : SUIT_TO_ELEMENT[signals.tarot.suit] ?? signals.element

      derivedEdges.push({
        source: `tarot:${signals.tarot.name.toLowerCase().replace(/\s+/g, "_")}`,
        target: `element:${tarotElement}`,
        type: "tarot_element_derivation",
        weight: 1.0,
        sourceType: "codex_table",
      })
    }
  }

  // Deduplicate edges
  const edgeSet = new Set<string>()
  const dedupedEdges: GraphEdge[] = []
  for (const edge of collectedEdges) {
    const key = `${edge.source}|${edge.target}|${edge.type}`
    if (!edgeSet.has(key)) {
      edgeSet.add(key)
      dedupedEdges.push(edge)
    }
  }

  // Collect node objects (only for nodes that exist in the graph)
  const nodes: GraphNode[] = []
  for (const nodeId of collectedNodeIds) {
    const node = graph.nodes.get(nodeId)
    if (node) nodes.push(node)
  }

  return {
    nodes,
    edges: dedupedEdges,
    derivedEdges,
    stats: {
      node_count: nodes.length,
      edge_count: dedupedEdges.length,
      derived_edge_count: derivedEdges.length,
    },
  }
}

/**
 * Collect 1-hop neighbor nodes and edges from a seed node.
 */
function collectNeighbors(
  graph: KnowledgeGraph,
  seedId: string,
  nodeIds: Set<string>,
  edges: GraphEdge[],
): void {
  const adjacent = graph.adjacency.get(seedId) ?? []
  for (const edge of adjacent) {
    nodeIds.add(edge.target)
    edges.push(edge)
  }
}

// ---------------------------------------------------------------------------
// Cultural Reference Resolution (Task 9.4)
// ---------------------------------------------------------------------------

/**
 * Resolve ancestor -> cultural references from graph.
 * Looks up edges of type "cultural_reference" from the ancestor node.
 */
export function resolveCulturalReferences(
  graph: KnowledgeGraph,
  ancestorId: string,
): CulturalReference[] {
  const fullId = ancestorId.startsWith("ancestor:") ? ancestorId : `ancestor:${ancestorId}`
  const adjacent = graph.adjacency.get(fullId) ?? []

  const results: CulturalReference[] = []
  for (const edge of adjacent) {
    if (edge.type === "cultural_reference") {
      const node = graph.nodes.get(edge.target)
      if (node) {
        results.push({
          id: node.id,
          label: node.label,
          weight: edge.weight,
        })
      }
    }
  }

  // Sort by weight descending, then by label alphabetically for stability
  results.sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
  return results
}

/**
 * Resolve archetype -> aesthetic preferences from graph.
 * Looks up edges of type "aesthetic_preference" from the archetype node.
 */
export function resolveAestheticPreferences(
  graph: KnowledgeGraph,
  archetypeId: string,
): AestheticPreference[] {
  const fullId = archetypeId.startsWith("archetype:") ? archetypeId : `archetype:${archetypeId}`
  const adjacent = graph.adjacency.get(fullId) ?? []

  const results: AestheticPreference[] = []
  for (const edge of adjacent) {
    if (edge.type === "aesthetic_preference") {
      const node = graph.nodes.get(edge.target)
      if (node) {
        results.push({
          id: node.id,
          label: node.label,
          weight: edge.weight,
        })
      }
    }
  }

  results.sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
  return results
}

/**
 * Resolve era -> philosophical foundations from graph.
 * Looks up edges of type "philosophical_foundation" from the era node.
 */
export function resolvePhilosophicalFoundations(
  graph: KnowledgeGraph,
  eraId: string,
): PhilosophicalFoundation[] {
  const fullId = eraId.startsWith("era:") ? eraId : `era:${eraId}`
  const adjacent = graph.adjacency.get(fullId) ?? []

  const results: PhilosophicalFoundation[] = []
  for (const edge of adjacent) {
    if (edge.type === "philosophical_foundation") {
      const node = graph.nodes.get(edge.target)
      if (node) {
        results.push({
          id: node.id,
          label: node.label,
          weight: edge.weight,
        })
      }
    }
  }

  results.sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
  return results
}

// ---------------------------------------------------------------------------
// Synthesis Subgraph Conversion (Sprint 11 Task 11.2)
// ---------------------------------------------------------------------------

/** Simplified subgraph format consumed by BeauvoirSynthesizer */
export interface SynthesisSubgraph {
  cultural_references: string[]
  aesthetic_notes: string[]
  philosophical_lineage: string[]
}

/**
 * Convert a full IdentitySubgraph into the simplified format used by BeauvoirSynthesizer.
 *
 * Extracts labels from graph nodes by type:
 * - Nodes with type containing "cultural" → cultural_references
 * - Nodes with type containing "aesthetic" → aesthetic_notes
 * - Nodes with type containing "philosoph" → philosophical_lineage
 *
 * Also merges resolved data from resolveCulturalReferences, resolveAestheticPreferences,
 * and resolvePhilosophicalFoundations when a graph is provided.
 */
export function toSynthesisSubgraph(
  subgraph: IdentitySubgraph,
  graph?: KnowledgeGraph | null,
  archetype?: string,
  ancestor?: string,
  era?: string,
): SynthesisSubgraph {
  const culturalRefs = new Set<string>()
  const aestheticNotes = new Set<string>()
  const philosophicalLineage = new Set<string>()

  // Extract from subgraph nodes by type
  for (const node of subgraph.nodes) {
    if (node.type.includes("cultural")) {
      culturalRefs.add(node.label)
    } else if (node.type.includes("aesthetic")) {
      aestheticNotes.add(node.label)
    } else if (node.type.includes("philosoph")) {
      philosophicalLineage.add(node.label)
    }
  }

  // Enrich with resolved data from graph traversal if available
  if (graph) {
    if (ancestor) {
      for (const ref of resolveCulturalReferences(graph, ancestor)) {
        culturalRefs.add(ref.label)
      }
    }
    if (archetype) {
      for (const pref of resolveAestheticPreferences(graph, archetype)) {
        aestheticNotes.add(pref.label)
      }
    }
    if (era) {
      for (const found of resolvePhilosophicalFoundations(graph, era)) {
        philosophicalLineage.add(found.label)
      }
    }
  }

  return {
    cultural_references: [...culturalRefs],
    aesthetic_notes: [...aestheticNotes],
    philosophical_lineage: [...philosophicalLineage],
  }
}

// ---------------------------------------------------------------------------
// Redis Caching (Task 9.5)
// ---------------------------------------------------------------------------

export interface IdentityGraphCacheConfig {
  redis: RedisCommandClient
  ttlSeconds?: number // Default 86400 (24h)
}

const DEFAULT_TTL_SECONDS = 86400

export class IdentityGraphCache {
  private readonly redis: RedisCommandClient
  private readonly ttlSeconds: number

  constructor(config: IdentityGraphCacheConfig) {
    this.redis = config.redis
    this.ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS
  }

  /**
   * Build cache key. Content-addressed: same inputs = same subgraph.
   * Format: identity:graph:{codex_version}:{archetype}:{ancestor_family}
   */
  private key(codexVersion: string, archetype: string, ancestorFamily: string): string {
    return `identity:graph:${codexVersion}:${archetype}:${ancestorFamily}`
  }

  /**
   * Get cached subgraph.
   */
  async get(
    codexVersion: string,
    archetype: string,
    ancestorFamily: string,
  ): Promise<IdentitySubgraph | null> {
    const cached = await this.redis.get(this.key(codexVersion, archetype, ancestorFamily))
    if (!cached) return null

    try {
      return JSON.parse(cached) as IdentitySubgraph
    } catch {
      return null
    }
  }

  /**
   * Store subgraph in cache with TTL.
   */
  async set(
    codexVersion: string,
    archetype: string,
    ancestorFamily: string,
    subgraph: IdentitySubgraph,
  ): Promise<void> {
    const k = this.key(codexVersion, archetype, ancestorFamily)
    await this.redis.set(k, JSON.stringify(subgraph))
    await this.redis.expire(k, this.ttlSeconds)
  }
}
