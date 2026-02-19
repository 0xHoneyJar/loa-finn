// src/nft/health.ts — Identity Subsystem Health Check (Sprint 16 Task 16.3)
//
// Reports identity subsystem readiness for merging into /health endpoint responses.

import type { KnowledgeGraphLoader } from "./identity-graph.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies for identity health check */
export interface IdentityHealthDeps {
  /** Knowledge graph loader instance (optional — absent means graph unavailable) */
  graphLoader?: KnowledgeGraphLoader
  /** Current codex version string (optional — absent means version unknown) */
  codexVersion?: string
}

/** Identity subsystem health status */
export interface IdentityHealthStatus {
  /** Whether the knowledge graph is loaded and accessible */
  graph_loaded: boolean
  /** Current codex data version (or "unknown") */
  codex_version: string
  /** Whether the synthesis pipeline is available (graph + codex both ready) */
  synthesis_available: boolean
}

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

/**
 * Get the health status of the identity subsystem.
 *
 * Returns a plain object suitable for merging into a /health endpoint response.
 * All checks are non-throwing — errors result in degraded status, not failures.
 */
export function getIdentityHealth(deps: IdentityHealthDeps): IdentityHealthStatus {
  let graphLoaded = false

  if (deps.graphLoader) {
    try {
      const graph = deps.graphLoader.load()
      graphLoaded = graph !== null && graph !== undefined
    } catch {
      graphLoaded = false
    }
  }

  const codexVersion = deps.codexVersion ?? "unknown"

  // Synthesis requires both graph and codex to be available
  const synthesisAvailable = graphLoaded && codexVersion !== "unknown"

  return {
    graph_loaded: graphLoaded,
    codex_version: codexVersion,
    synthesis_available: synthesisAvailable,
  }
}
