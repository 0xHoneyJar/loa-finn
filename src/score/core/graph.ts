// src/score/core/graph.ts — shared agent-universe helpers (cycle-041 Sprint 1).
//
// One source of truth for "which agents exist in this graph", so the leaderboard, features, and
// clustering all reason over the SAME universe (review fix #4 — previously features/cluster only
// iterated `buyersOf` while the leaderboard included edge + deployer agents).

import type { TxGraph } from "../edge/port.js"

/** Every agent id that appears anywhere in the graph (edges, buyersOf, deployerOf), sorted. */
export function allAgentIds(graph: TxGraph): string[] {
  const s = new Set<string>()
  for (const e of graph.edges) s.add(e.agent)
  for (const a of graph.buyersOf.keys()) s.add(a)
  for (const a of graph.deployerOf.keys()) s.add(a)
  return [...s].sort()
}

/** Distinct buyer set for an agent (empty set if the agent has no recorded buyers). */
export function buyerSetOf(graph: TxGraph, agent: string): Set<string> {
  return graph.buyersOf.get(agent) ?? new Set<string>()
}
