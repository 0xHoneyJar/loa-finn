// src/score/core/cluster.ts — FR-2 counterparty/deployer clustering (cycle-041 Sprint 1, T1.4)
//
// Union-find over agents that share a deployer wallet OR whose buyer sets overlap at/above
// a threshold. Clone fleets (shared deployer) and circular-trade rings (shared counterparties)
// collapse into one cluster_id — the structural wash signature. PURE.
//
// Plain Map/Set union-find; no graph library at this scale (SDD §5; "over-building the graph
// layer" is the named anti-pattern in the sprint plan).

import type { TxGraph } from "../edge/port.js"
import { jaccard } from "./features.js"

export interface ClusterResult {
  agentId: string
  clusterId: string // union-find root (deterministic: lexicographically smallest member)
  sharedDeployer?: string
}

export function clusterCounterparties(graph: TxGraph, overlapThreshold = 1): ClusterResult[] {
  const agents = [...graph.buyersOf.keys()].sort()
  const parent = new Map<string, string>()
  for (const a of agents) parent.set(a, a)

  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root) as string
    // path compression
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (x: string, y: string): void => {
    const rx = find(x)
    const ry = find(y)
    if (rx === ry) return
    // deterministic: smaller id becomes the root
    if (rx < ry) parent.set(ry, rx)
    else parent.set(rx, ry)
  }

  // 1. union on shared deployer
  const byDeployer = new Map<string, string[]>()
  for (const a of agents) {
    const d = graph.deployerOf.get(a)
    if (!d) continue
    const arr = byDeployer.get(d) ?? []
    arr.push(a)
    byDeployer.set(d, arr)
  }
  for (const arr of byDeployer.values()) {
    for (let i = 1; i < arr.length; i++) union(arr[0], arr[i])
  }

  // 2. union on buyer-set overlap >= threshold (shared counterparties)
  for (let i = 0; i < agents.length; i++) {
    const A = graph.buyersOf.get(agents[i]) ?? new Set<string>()
    if (A.size === 0) continue
    for (let k = i + 1; k < agents.length; k++) {
      const B = graph.buyersOf.get(agents[k]) ?? new Set<string>()
      if (B.size === 0) continue
      if (jaccard(A, B) >= overlapThreshold) union(agents[i], agents[k])
    }
  }

  return agents.map((a) => ({
    agentId: a,
    clusterId: find(a),
    sharedDeployer: graph.deployerOf.get(a),
  }))
}
