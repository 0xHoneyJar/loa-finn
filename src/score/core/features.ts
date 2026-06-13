// src/score/core/features.ts — FR-2 deterministic features (cycle-041 Sprint 1, T1.3)
//
// The two load-bearing wash features, both PURE:
//   1. buyer-set Jaccard overlap  — |A∩B| / |A∪B| over distinct buyer wallets
//   2. buyer-count band-deviation — distance of distinct-buyer-count from the ~100–200
//      "farming band". 0 ⇒ INSIDE the band (farm-optimal, suspicious); >0 ⇒ outside.
//
// No I/O, no clock, no randomness → reproducible (NFR-1).

import type { TxGraph } from "../edge/port.js"
import { allAgentIds, buyerSetOf } from "./graph.js"

export interface JaccardPair {
  otherAgentId: string
  jaccard: number
}

export interface JaccardResult {
  agentId: string
  maxJaccard: number
  pairs: JaccardPair[] // agents with non-zero overlap, sorted by jaccard desc then id asc
}

/** Jaccard similarity of two sets: |A∩B| / |A∪B|. Empty/empty ⇒ 0 (no signal, not NaN). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let inter = 0
  for (const x of small) if (large.has(x)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/** Per-agent max buyer-set Jaccard overlap with every other agent (feature 1). */
export function jaccardOverlap(graph: TxGraph): JaccardResult[] {
  const agents = allAgentIds(graph)
  const results: JaccardResult[] = []
  for (const a of agents) {
    const A = buyerSetOf(graph, a)
    const pairs: JaccardPair[] = []
    let max = 0
    for (const b of agents) {
      if (b === a) continue
      const B = buyerSetOf(graph, b)
      const j = jaccard(A, B)
      if (j > 0) pairs.push({ otherAgentId: b, jaccard: j })
      if (j > max) max = j
    }
    pairs.sort((x, y) => y.jaccard - x.jaccard || (x.otherAgentId < y.otherAgentId ? -1 : 1))
    results.push({ agentId: a, maxJaccard: max, pairs })
  }
  return results
}

/** The ~100–200 "farming band" interval (a subset of `Thresholds`; named to avoid colliding
 * with the verdict `Band` union in `screen.ts`). */
export interface BandRange {
  bandLow: number
  bandHigh: number
}

/**
 * Per-agent deviation of distinct-buyer-count from the farming band (feature 2).
 * Returns 0 when the count is INSIDE [bandLow, bandHigh] (the farm-optimal range), else
 * the distance to the nearest band edge. Lower ⇒ more farm-consistent.
 */
export function buyerCountDeviation(graph: TxGraph, band: BandRange): Map<string, number> {
  const out = new Map<string, number>()
  for (const a of allAgentIds(graph)) {
    const c = buyerSetOf(graph, a).size
    let dev = 0
    if (c < band.bandLow) dev = band.bandLow - c
    else if (c > band.bandHigh) dev = c - band.bandHigh
    out.set(a, dev)
  }
  return out
}
