// src/nft/identity-graph-resolver.ts — Identity Graph Resolver Factory (Cycle 040, Sprint 2 T-2.1)
//
// Creates the resolveSubgraph function for PipelineOrchestratorConfig.
// Loads the knowledge graph once, then extracts per-signal subgraphs
// and converts to the SynthesisSubgraph format for BeauvoirSynthesizer.

import { KnowledgeGraphLoader, extractSubgraph, toSynthesisSubgraph } from "./identity-graph.js"
import type { IdentitySubgraph as SynthesisSubgraph } from "./beauvoir-synthesizer.js"
import type { SignalSnapshot } from "./signal-types.js"

/**
 * Create a resolveSubgraph function for the pipeline orchestrator.
 *
 * Loads the mibera-codex knowledge graph once, then for each call:
 * 1. extractSubgraph() — builds persona-specific neighborhood
 * 2. toSynthesisSubgraph() — converts to { cultural_references, aesthetic_notes, philosophical_lineage }
 *
 * Returns null if graph loading fails or extraction produces no nodes.
 */
export function createSubgraphResolver(): (snapshot: SignalSnapshot) => Promise<SynthesisSubgraph | null> {
  const loader = new KnowledgeGraphLoader()
  let graph: ReturnType<typeof loader.load> | null = null
  let loadAttempted = false

  return async (snapshot: SignalSnapshot): Promise<SynthesisSubgraph | null> => {
    // Lazy-load graph on first call
    if (!graph && !loadAttempted) {
      loadAttempted = true
      try {
        graph = loader.load()
      } catch (err) {
        console.error(
          JSON.stringify({
            metric: "finn.identity_graph",
            stage: "load",
            error: (err as Error).message,
            severity: "warn",
          }),
        )
        return null
      }
    }

    if (!graph) return null

    // Extract persona-specific subgraph
    const sub = extractSubgraph(graph, snapshot.archetype, snapshot.ancestor, snapshot)
    if (sub.stats.node_count === 0) return null

    // Convert to synthesis format
    const synthesis = toSynthesisSubgraph(
      sub,
      graph,
      snapshot.archetype,
      snapshot.ancestor,
      snapshot.era,
    )

    // Only return if we have any content
    if (
      synthesis.cultural_references.length === 0 &&
      synthesis.aesthetic_notes.length === 0 &&
      synthesis.philosophical_lineage.length === 0
    ) {
      return null
    }

    return synthesis
  }
}
