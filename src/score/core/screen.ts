// src/score/core/screen.ts — FR-2 anomaly screen (cycle-041 Sprint 1, T1.4)
//
// Composes the leaderboard + the two features + clustering into a per-agent INTERNAL
// anomaly band. This is a SCREEN, never a published verdict (FR-2 / FR-2a): the output
// is consumed by the Sprint-3 validation harness and Sprint-4 publication-hold, NOT posted.
//
// Classification precedence (severity-ordered; FR-2a "do not over-accuse"):
//   1. naive_farm  (in-band + high overlap + clustered)  → HIGH   — strong multi-feature wash
//   2. relay_double_count (circular ≥ 50%)               → MED    — concrete: revenue from agents
//   3. subsidy_capture (subsidy ≥ 50%)                   → MED    — factual: subsidy-funded, NOT an
//                                                                   accusation of wash (review fix #2)
//   4. legit_shared_audience (high overlap, not naive)   → INSUFFICIENT_EVIDENCE — ambiguous overlap
//   5. adaptive_farm (in-band, no overlap)               → MED    — count-only, unconfirmed
//   6. none                                              → LOW
//
// naive_farm is checked FIRST so a strong HIGH signal is never downgraded by a weaker MED one
// (review fix #1). Subsidy/circular cut-offs use BIGINT math (x*2 ≥ denom) — no `Number(bigint)`
// rounding that could flip the 50% boundary for large values (review fix #3).
//
// Hard invariants enforced by construction (sprint-finn-score.md ACs, SDD §4.2):
//   • adaptive_farm is NEVER tagged HIGH.
//   • legit_shared_audience ⇒ INSUFFICIENT_EVIDENCE (false-positive guard).
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
  | "subsidy_capture" // high prize-pool subsidy share                        (DETECTED, factual)
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

// Buyer-set overlap that unions a cluster. DECOUPLED from the feature's `jaccardHigh` (review fix #5):
// clustering and the per-agent overlap feature are different knobs. NOTE: detecting farms that share
// only a FEW counterparties among many buyers (low Jaccard, the "all buyers transact with the same
// 5–6 agents" pattern) needs a raw shared-counterparty feature — deferred to Sprint 2. Sprint-1
// clustering catches clone fleets (shared deployer) + near-identical buyer sets.
export const CLUSTER_OVERLAP_HIGH = 0.5

export function screenAnomaly(graph: TxGraph, t: Thresholds): ScreenResult[] {
  const leaderboard = recomputeLeaderboard(graph)
  const jac = new Map(jaccardOverlap(graph).map((r) => [r.agentId, r]))
  const dev = buyerCountDeviation(graph, { bandLow: t.bandLow, bandHigh: t.bandHigh })
  const clusters = clusterCounterparties(graph, CLUSTER_OVERLAP_HIGH)
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

    // BIGINT threshold math — no Number() rounding (review fix #3).
    const denomSubsidy = rev.grossMicro + rev.subsidyMicro
    const subsidyHigh = denomSubsidy > 0n && rev.subsidyMicro * 2n >= denomSubsidy // ≥ 50%
    const circularHigh = rev.grossMicro > 0n && rev.circularMicro * 2n >= rev.grossMicro // ≥ 50%

    const inBand = bandDeviation === 0 && rev.distinctBuyers > 0
    const highOverlap = maxJaccard >= t.jaccardHigh

    let adversaryTag: AdversaryTag
    let band: Band
    if (inBand && highOverlap && clustered) {
      adversaryTag = "naive_farm"
      band = "HIGH"
    } else if (circularHigh) {
      adversaryTag = "relay_double_count"
      band = "MED"
    } else if (subsidyHigh) {
      // revenue is mostly subsidy, not customers — a factual flag, NOT a wash accusation (no HIGH)
      adversaryTag = "subsidy_capture"
      band = "MED"
    } else if (highOverlap) {
      // overlap WITHOUT the full naive-farm combo and no concrete signal → ambiguous → never accuse
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
