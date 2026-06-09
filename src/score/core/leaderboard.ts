// src/score/core/leaderboard.ts — FR-1 independent leaderboard (cycle-041 Sprint 1, T1.2)
//
// PURE. Recomputes the agent leaderboard from the abstract TxGraph, independent of any
// platform-published ranking, and decomposes claimed revenue into gross / subsidy / net.
//
// `net` = gross service revenue MINUS prize-pool subsidy MINUS circular revenue (revenue
// from buyers that are themselves agents in the same epoch — the wash signature). This is
// the "read through the painted leaderboard" computation: rank by net, not by gross.
//
// No I/O, no clock, no randomness → reproducible (NFR-1).

import type { TxGraph } from "../edge/port.js"
import { allAgentIds } from "./graph.js"

export interface AgentRevenue {
  agentId: string
  grossMicro: bigint // all non-subsidy service revenue
  subsidyMicro: bigint // prize-pool subsidy edges
  netMicro: bigint // gross minus circular (buyer is itself an agent)
  circularMicro: bigint // non-subsidy revenue from agent-buyers (wash)
  distinctBuyers: number // distinct non-subsidy buyers
  recomputedRank: number // 1-based, by net desc (FR-1)
}

interface Agg {
  gross: bigint
  subsidy: bigint
  net: bigint
  circular: bigint
  buyers: Set<string>
}

export function recomputeLeaderboard(graph: TxGraph): AgentRevenue[] {
  const agentSet = new Set(allAgentIds(graph))
  const agg = new Map<string, Agg>()
  const ensure = (a: string): Agg => {
    let r = agg.get(a)
    if (!r) {
      r = { gross: 0n, subsidy: 0n, net: 0n, circular: 0n, buyers: new Set() }
      agg.set(a, r)
    }
    return r
  }
  for (const a of agentSet) ensure(a)

  for (const e of graph.edges) {
    const r = ensure(e.agent)
    if (e.isSubsidy) {
      r.subsidy += e.amountMicro
      continue
    }
    r.gross += e.amountMicro
    r.buyers.add(e.buyer)
    if (agentSet.has(e.buyer)) r.circular += e.amountMicro // buyer is an agent → wash/circular
    else r.net += e.amountMicro
  }

  const rows: AgentRevenue[] = [...agg.entries()].map(([agentId, r]) => ({
    agentId,
    grossMicro: r.gross,
    subsidyMicro: r.subsidy,
    netMicro: r.net,
    circularMicro: r.circular,
    distinctBuyers: r.buyers.size,
    recomputedRank: 0,
  }))

  // Deterministic order: net desc, then gross desc, then agentId asc.
  rows.sort((x, y) => {
    if (y.netMicro !== x.netMicro) return y.netMicro > x.netMicro ? 1 : -1
    if (y.grossMicro !== x.grossMicro) return y.grossMicro > x.grossMicro ? 1 : -1
    return x.agentId < y.agentId ? -1 : x.agentId > y.agentId ? 1 : 0
  })
  rows.forEach((r, i) => {
    r.recomputedRank = i + 1
  })
  return rows
}
