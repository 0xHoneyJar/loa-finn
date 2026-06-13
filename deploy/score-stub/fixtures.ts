// deploy/score-stub/fixtures.ts — deterministic layered fact-sheets at 3 sizes
// (sprint-169 T5.2 — Finn cost-of-play V1)
//
// Payload realism is LOAD-BEARING: a tiny-payload stub invalidates the infra
// measurement (enhance doc item 2). Sizes sampled from the score-api PR #263
// layered fact-sheet shapes: ~2KB sparse / ~15KB typical / ~60KB dense
// cluster graph. Fixture byte-sizes are part of the contract and asserted in
// stub tests.
//
// Vocabulary note (flatline HC9): the band/tag literals below are INTENTIONAL
// duplicates of src/score/core/screen.ts — the stub must NOT import from
// src/score/ (sealed island, producer-side). If the producer vocabulary
// drifts, the stub tests are where we notice.

export const BANDS = ["HIGH", "MED", "LOW", "INSUFFICIENT_EVIDENCE"] as const
export type Band = (typeof BANDS)[number]

export const ADVERSARY_TAGS = [
  "naive_farm",
  "subsidy_capture",
  "adaptive_farm",
  "legit_shared_audience",
  "relay_double_count",
  "none",
] as const
export type AdversaryTag = (typeof ADVERSARY_TAGS)[number]

export type SizeClass = "sparse" | "typical" | "dense"

/** Contract byte-size bands per class (asserted in tests). */
export const SIZE_BANDS: Record<SizeClass, { min: number; max: number }> = {
  sparse: { min: 1_500, max: 3_500 },
  typical: { min: 12_000, max: 18_000 },
  dense: { min: 50_000, max: 70_000 },
}

export interface FactSheet {
  agent: { name: string; symbol: string; provider: string }
  layers: {
    observed: Record<string, unknown>
    structural: Record<string, unknown>
    readings: Array<{ flag: string; note: string }>
    claim: { verdict: string; band: Band; adversary_tag: AdversaryTag }
  }
}

/** Deterministic 32-bit FNV-1a hash — fixture selection by agent id. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function sizeClassFor(agentId: string): SizeClass {
  const h = fnv1a(agentId) % 3
  return h === 0 ? "sparse" : h === 1 ? "typical" : "dense"
}

/** Deterministic pseudo-address from a seed (40 hex chars). */
function addr(seed: number): string {
  let out = ""
  let x = seed >>> 0
  while (out.length < 40) {
    x = Math.imul(x, 0x01000193) + 0x9e3779b9
    out += (x >>> 0).toString(16).padStart(8, "0")
  }
  return "0x" + out.slice(0, 40)
}

function buyerRow(seed: number): Record<string, unknown> {
  return {
    buyer: addr(seed),
    settled_jobs: 100 + (seed % 900),
    revenue_usdc: `${(seed % 50) + 1}.${(seed % 97).toString().padStart(2, "0")}`,
    first_seen_epoch: 1 + (seed % 5),
    last_seen_epoch: 5,
  }
}

function clusterEdge(seed: number): Record<string, unknown> {
  return {
    from: addr(seed),
    to: addr(seed + 7),
    jaccard: ((seed % 100) / 100).toFixed(2),
    shared_buyers: seed % 12,
    edge_type: seed % 2 === 0 ? "shared_buyer_set" : "shared_deployer",
  }
}

/** Build the deterministic fact-sheet for an agent id. The claim layer is
 *  derived from the id hash so the SAME id always yields the SAME verdict —
 *  the load driver controls the abstain mix by choosing ids. */
export function buildFactSheet(agentId: string): FactSheet {
  const h = fnv1a(agentId)
  const size = sizeClassFor(agentId)

  // Claim layer: abstain-by-default posture (PR #263). ~1/3 of ids abstain.
  const abstain = h % 3 === 0
  const band: Band = abstain ? "INSUFFICIENT_EVIDENCE" : (["HIGH", "MED", "LOW"] as const)[h % 3 === 1 ? 0 : 1 + (h % 2)]
  const tag: AdversaryTag = abstain
    ? "none"
    : band === "HIGH"
      ? (["naive_farm", "subsidy_capture", "relay_double_count"] as const)[h % 3]
      : "none"

  const observed = {
    settled_jobs: 1000 + (h % 30_000),
    distinct_buyers: 2 + (h % 40),
    revenue_usdc: `${(h % 900) + 10}.${(h % 89).toString().padStart(2, "0")}`,
    epochs_active: 1 + (h % 6),
    confidence: 1.0,
  }

  const buyerCount = size === "sparse" ? 5 : size === "typical" ? 28 : 60
  const edgeCount = size === "sparse" ? 0 : size === "typical" ? 36 : 220
  const readingCount = size === "sparse" ? 3 : size === "typical" ? 10 : 24

  const structural: Record<string, unknown> = {
    largest_funder_cluster: {
      funder: addr(h),
      buyers: buyerCount,
      revenue_share: ((h % 80) / 100 + 0.17).toFixed(2),
    },
    buyer_rows: Array.from({ length: buyerCount }, (_, i) => buyerRow(h + i * 13)),
    cluster_graph: {
      nodes: edgeCount === 0 ? [] : Array.from({ length: Math.floor(edgeCount / 2) }, (_, i) => addr(h + i * 29)),
      edges: Array.from({ length: edgeCount }, (_, i) => clusterEdge(h + i * 31)),
    },
  }

  const readings = Array.from({ length: readingCount }, (_, i) => ({
    flag: ["in_farming_band", "buyer_overlap_high", "subsidy_share_elevated", "relay_pattern_partial"][
      (h + i) % 4
    ],
    note:
      "Deterministic stub reading: feature computed over the observed transaction graph window; " +
      "details mirror the PR #263 readings layer at representative verbosity for payload realism.",
  }))

  return {
    agent: {
      name: `agent-${(h % 10_000).toString().padStart(4, "0")}`,
      symbol: `AGT${(h % 999).toString().padStart(3, "0")}`,
      provider: addr(h ^ 0xdeadbeef),
    },
    layers: {
      observed,
      structural,
      readings,
      claim: {
        verdict: abstain ? "ABSTAIN" : "CLAIM",
        band,
        adversary_tag: tag,
      },
    },
  }
}
