// src/score/core/screen.ts — FR-2 anomaly screen (cycle-041 Sprint 1, T1.4)
//
// Composes the leaderboard + the two features + clustering into a per-agent INTERNAL
// anomaly band. This is a SCREEN, never a published verdict (FR-2 / FR-2a): the output
// is consumed by the Sprint-3 validation harness and Sprint-4 publication-hold, NOT posted.
//
// Hard invariants enforced by construction (sprint-finn-score.md ACs, SDD §4.2):
//   • `adaptive_farm` is NEVER tagged HIGH (the 2-feature screen cannot confirm an evasive farm).
//   • `legit_shared_audience` ⇒ INSUFFICIENT_EVIDENCE (false-positive guard — real shared
//     audiences must not be accused).
//
// No I/O, no clock, no randomness → reproducible (NFR-1).

import type { TxGraph } from "../edge/port.js"
import { recomputeLeaderboard } from "./leaderboard.js"
import { jaccardOverlap, buyerCountDeviation } from "./features.js"
import { clusterCounterparties } from "./cluster.js"

export type Band = "HIGH" | "MED" | "LOW" | "INSUFFICIENT_EVIDENCE"

export interface Thresholds {
  bandLow: number // the ~100–200 farming band, low edge
  bandHigh: number // the ~100–200 farming band, high edge
  jaccardHigh: number // buyer-set overlap that trips the anomaly feature
  precisionBar: number // FR-2a pre-set validation bar (used in Sprint 3, carried here for the contract)
}

export type AdversaryTag =
  | "naive_farm" // shared 5–6 counterparties + banded buyer count            (DETECTED)
  | "subsidy_capture" // high prize-pool subsidy share                        (DETECTED)
  | "adaptive_farm" // disjoint pools, jittered counts                        (NOT DETECTED → not HIGH)
  | "legit_shared_audience" // real community overlap → false-positive risk   (→ INSUFFICIENT)
  | "relay_double_count" // circular A→B→C revenue                            (PARTIAL)
  | "none"

export interface ScreenResult {
  agentId: string
  recomputedRank: number
  netRevenueMicro: bigint
  distinctBuyers: number
  bandDeviation: number // FR-2 feature 2 (0 ⇒ inside the farming band)
  maxJaccard: number // FR-2 feature 1
  jaccardPairs: { otherAgentId: string; jaccard: number }[]
  clusterId?: string // set only when the agent shares a cluster with ≥1 other agent
  sharedDeployer?: string
  band: Band // INTERNAL screen (FR-2)
  adversaryTag: AdversaryTag
}

// Share cut-offs for the subsidy/circular features. Kept as named module constants (not in
// `Thresholds`, which the SDD fixes to the band/jaccard/precision knobs) so the contract stays
// verbatim; tunable here once real epoch data lands (Sprint 2).
export const SUBSIDY_SHARE_HIGH = 0.5
export const CIRCULAR_SHARE_HIGH = 0.5

export function screenAnomaly(graph: TxGraph, t: Thresholds): ScreenResult[] {
  const leaderboard = recomputeLeaderboard(graph)
  const jac = new Map(jaccardOverlap(graph).map((r) => [r.agentId, r]))
  const dev = buyerCountDeviation(graph, { bandLow: t.bandLow, bandHigh: t.bandHigh })
  const clusters = clusterCounterparties(graph, t.jaccardHigh)
  const clusterOf = new Map(clusters.map((c) => [c.agentId, c]))
  const clusterSize = new Map<string, number>()
  for (const c of clusters) clusterSize.set(c.clusterId, (clusterSize.get(c.clusterId) ?? 0) + 1)

  const results: ScreenResult[] = leaderboard.map((rev) => {
    const j = jac.get(rev.agentId)
    const maxJaccard = j?.maxJaccard ?? 0
    const jaccardPairs = j?.pairs ?? []
    const bandDeviation = dev.get(rev.agentId) ?? 0
    const cl = clusterOf.get(rev.agentId)
    const clustered = cl ? (clusterSize.get(cl.clusterId) ?? 0) > 1 : false

    const denomSubsidy = rev.grossMicro + rev.subsidyMicro
    const subsidyShare = denomSubsidy > 0n ? Number(rev.subsidyMicro) / Number(denomSubsidy) : 0
    const circularShare = rev.grossMicro > 0n ? Number(rev.circularMicro) / Number(rev.grossMicro) : 0

    const inBand = bandDeviation === 0 && rev.distinctBuyers > 0
    const highOverlap = maxJaccard >= t.jaccardHigh

    let adversaryTag: AdversaryTag
    let band: Band
    if (subsidyShare >= SUBSIDY_SHARE_HIGH) {
      adversaryTag = "subsidy_capture"
      band = "HIGH"
    } else if (circularShare >= CIRCULAR_SHARE_HIGH) {
      adversaryTag = "relay_double_count"
      band = "MED"
    } else if (inBand && highOverlap && clustered) {
      adversaryTag = "naive_farm"
      band = "HIGH"
    } else if (highOverlap) {
      // high overlap WITHOUT the full naive-farm combo → ambiguous → never accuse
      adversaryTag = "legit_shared_audience"
      band = "INSUFFICIENT_EVIDENCE"
    } else if (inBand) {
      // banded buyer count but no overlap corroboration → evasive/unconfirmed
      adversaryTag = "adaptive_farm"
      band = "MED"
    } else {
      adversaryTag = "none"
      band = "LOW"
    }

    // Hard invariants (defense in depth; the branches above already honor them).
    if (adversaryTag === "adaptive_farm" && band === "HIGH") band = "MED"
    if (adversaryTag === "legit_shared_audience") band = "INSUFFICIENT_EVIDENCE"

    return {
      agentId: rev.agentId,
      recomputedRank: rev.recomputedRank,
      netRevenueMicro: rev.netMicro,
      distinctBuyers: rev.distinctBuyers,
      bandDeviation,
      maxJaccard,
      jaccardPairs,
      clusterId: clustered ? cl?.clusterId : undefined,
      sharedDeployer: cl?.sharedDeployer,
      band,
      adversaryTag,
    }
  })

  // Deterministic output order: by recomputed rank, then agent id.
  results.sort((a, b) =>
    a.recomputedRank !== b.recomputedRank
      ? a.recomputedRank - b.recomputedRank
      : a.agentId < b.agentId
        ? -1
        : a.agentId > b.agentId
          ? 1
          : 0,
  )
  return results
}
