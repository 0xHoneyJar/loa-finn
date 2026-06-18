// src/research/indexing-crossover.ts — the rlaihf READER for the indexing TCO
// experiment (epic bd-idx-tco-exp-s7r5, synthesis task .4).
//
// Turns the hash-chained ledger of IndexingExperimentRow into the crossover the
// sonar ADR is ratified against:
//   · L1: does MANAGED beat SOVEREIGN-Ponder on TCO-incl-toil at each footprint?
//   · L2: the firehose cost/latency curve vs collection_count, per store, and the
//     ClickHouse-vs-Postgres storage delta.
//
// THE KEN-THOMPSON INVARIANT (the whole reason this experiment exists):
//   A verdict inherits the WEAKEST cost_source of the rows it rests on. If any
//   input is vendor-quote, the verdict is at best "vendor-quote". If any is
//   projected, the verdict is "projected". A verdict can NEVER be rendered as
//   "measured" unless EVERY row it used is measured. This is the mechanical
//   refusal to present a projection as a measurement — the exact failure that
//   produced the contested $84/$300.
//
// TOIL IS PRICED, AND THE PRICE IS AN ASSUMPTION WE STATE. TCO-incl-toil folds
// operator attention in at a configurable $/hr. That rate is NOT measured — the
// verdict surfaces it as a caveat so no one mistakes the toil-inclusive ranking
// for a pure-cost fact.

import {
  COST_SOURCE_TRUST,
  type CostSource,
  type IndexingConfig,
  type IndexingExperimentRow,
  microToUsd,
} from "./schemas/indexing-experiment-row.js"

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface CrossoverParams {
  /** The price of operator attention, $/hr. An ASSUMPTION, surfaced as a caveat.
   *  Defaults to a senior-engineer opportunity cost. */
  operator_rate_usd_hr: number
  /** Window (months) over which one-time setup toil is amortized. */
  amortize_months: number
}

export const DEFAULT_CROSSOVER_PARAMS: CrossoverParams = {
  operator_rate_usd_hr: 150,
  amortize_months: 12,
}

// ---------------------------------------------------------------------------
// Trust algebra — the Ken-Thompson invariant
// ---------------------------------------------------------------------------

/** The weakest (lowest-trust) cost_source among the inputs. An empty set is
 *  "projected" (nothing measured ⇒ assume the floor). This is the function that
 *  forbids a quote/projection from masquerading as a measurement. */
export function weakestCostSource(sources: readonly CostSource[]): CostSource {
  if (sources.length === 0) return "projected"
  return sources.reduce((weakest, s) =>
    COST_SOURCE_TRUST[s] < COST_SOURCE_TRUST[weakest] ? s : weakest,
  )
}

/** Human caveat for a trust level — what the number may and may NOT be used for. */
export function trustCaveat(trust: CostSource): string {
  switch (trust) {
    case "measured":
      return "measured — a real bill/run on the real footprint; ratify on this."
    case "vendor-quote":
      return "vendor-quote — current published price for the identical footprint, NOT a run; directional, confirm with a real stand-up before ratifying."
    case "projected":
      return "projected — a model/extrapolation; sets direction only, NEVER a settled number."
  }
}

// ---------------------------------------------------------------------------
// TCO-incl-toil
// ---------------------------------------------------------------------------

export interface TcoBreakdown {
  config: IndexingConfig
  scenario: string
  collection_count: number
  pure_usd_month: number
  monthly_toil_hours: number
  toil_usd_month: number
  tco_incl_toil_usd: number
  cost_source: CostSource
  sovereignty: 0 | 1
}

/** Monthly toil hours = amortized setup + monthly incident-handling time.
 *  toil_incidents_30d is already a ~monthly rate. */
export function monthlyToilHours(row: IndexingExperimentRow, amortizeMonths: number): number {
  const setupPerMonth = row.toil_minutes_setup / amortizeMonths
  const incidentMinutes = row.toil_incidents_30d * row.toil_minutes_per_incident
  return (setupPerMonth + incidentMinutes) / 60
}

export function tcoBreakdown(row: IndexingExperimentRow, params: CrossoverParams): TcoBreakdown {
  const pure = microToUsd(row.cost_usd_month_micro)
  const toilHours = monthlyToilHours(row, params.amortize_months)
  const toilUsd = toilHours * params.operator_rate_usd_hr
  return {
    config: row.config,
    scenario: row.scenario,
    collection_count: row.collection_count,
    pure_usd_month: round2(pure),
    monthly_toil_hours: round2(toilHours),
    toil_usd_month: round2(toilUsd),
    tco_incl_toil_usd: round2(pure + toilUsd),
    cost_source: row.cost_source,
    sovereignty: row.sovereignty,
  }
}

// ---------------------------------------------------------------------------
// L1 — registration-config TCO crossover, per footprint
// ---------------------------------------------------------------------------

export interface WinnerRef {
  config: IndexingConfig
  usd: number
  cost_source: CostSource
}

export interface L1FootprintVerdict {
  scenario: string
  collection_count: number
  rows: TcoBreakdown[]
  pure_cost_winner: WinnerRef
  tco_incl_toil_winner: WinnerRef
  /** Weakest cost_source among the configs compared at this footprint. */
  trust: CostSource
  /** Whether folding toil in CHANGES the winner (the operator's #1 signal). */
  toil_flips_winner: boolean
  /** The operator-attention price ($/hr) at which the pure-$ winner stops being
   *  the TCO winner. null = the pure-$ winner is ALSO the least-toily, so it
   *  dominates at every rate (no toil price overturns it). This REMOVES the
   *  toil-rate assumption from the conclusion: if breakeven is trivially low,
   *  managed wins under any sane valuation of attention. */
  breakeven_toil_rate_usd_hr: number | null
}

export interface L1Verdict {
  /** Head-to-head footprints (≥2 distinct configs present). */
  footprints: L1FootprintVerdict[]
  /** Single-config rows surfaced for reference (e.g. the as-billed baseline). */
  reference_rows: TcoBreakdown[]
  /** Weakest cost_source across every footprint compared. */
  trust: CostSource
  summary: string
}

const L1_CONFIGS: readonly IndexingConfig[] = ["ponder-railway", "envio-hyperindex", "goldsky"]

function pickWinner(rows: TcoBreakdown[], key: "pure_usd_month" | "tco_incl_toil_usd"): WinnerRef {
  const best = rows.reduce((a, b) => (b[key] < a[key] ? b : a))
  return { config: best.config, usd: best[key], cost_source: best.cost_source }
}

/** The toil rate ($/hr) at which the pure-$ winner is first overtaken on TCO. A
 *  competitor C overtakes the pure-$ winner P as the rate rises iff C is pricier
 *  in dollars (C.pure > P.pure) BUT less toily (C.toilH < P.toilH); they tie at
 *  r = (C.pure − P.pure) / (P.toilH − C.toilH). The breakeven is the SMALLEST such
 *  r (the first competitor to flip it). null ⇒ P is also the least-toily and
 *  dominates at every rate. */
export function breakevenToilRate(breakdowns: TcoBreakdown[]): number | null {
  if (breakdowns.length < 2) return null
  const p = breakdowns.reduce((a, b) => (b.pure_usd_month < a.pure_usd_month ? b : a))
  let min: number | null = null
  for (const c of breakdowns) {
    if (c === p) continue
    const dToil = p.monthly_toil_hours - c.monthly_toil_hours
    const dCost = c.pure_usd_month - p.pure_usd_month
    if (dToil > 0 && dCost > 0) {
      const r = dCost / dToil
      if (min === null || r < min) min = r
    }
  }
  return min === null ? null : Math.round(min * 100) / 100
}

export function computeL1Verdict(
  rows: IndexingExperimentRow[],
  params: CrossoverParams,
): L1Verdict | null {
  const l1 = rows.filter((r) => r.layer === "L1-curated")
  if (l1.length === 0) return null

  // Group by scenario (footprint point). Within a scenario, dedupe by config —
  // last write wins (a re-measured row supersedes its earlier estimate).
  const byScenario = new Map<string, Map<IndexingConfig, IndexingExperimentRow>>()
  for (const r of l1) {
    if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, new Map())
    byScenario.get(r.scenario)!.set(r.config, r)
  }

  const footprints: L1FootprintVerdict[] = []
  const referenceRows: TcoBreakdown[] = []

  for (const [scenario, configMap] of byScenario) {
    const breakdowns = [...configMap.values()].map((r) => tcoBreakdown(r, params))
    if (configMap.size < 2) {
      referenceRows.push(...breakdowns)
      continue
    }
    const pureWinner = pickWinner(breakdowns, "pure_usd_month")
    const tcoWinner = pickWinner(breakdowns, "tco_incl_toil_usd")
    footprints.push({
      scenario,
      collection_count: breakdowns[0].collection_count,
      rows: breakdowns.sort((a, b) => a.tco_incl_toil_usd - b.tco_incl_toil_usd),
      pure_cost_winner: pureWinner,
      tco_incl_toil_winner: tcoWinner,
      trust: weakestCostSource(breakdowns.map((b) => b.cost_source)),
      toil_flips_winner: pureWinner.config !== tcoWinner.config,
      breakeven_toil_rate_usd_hr: breakevenToilRate(breakdowns),
    })
  }

  // Order footprints by collection_count (the 1x→2x→5x curve).
  footprints.sort((a, b) => a.collection_count - b.collection_count)

  const overallTrust = weakestCostSource(footprints.map((f) => f.trust))
  return {
    footprints,
    reference_rows: referenceRows,
    trust: overallTrust,
    summary: l1Summary(footprints, params, overallTrust),
  }
}

function l1Summary(
  footprints: L1FootprintVerdict[],
  params: CrossoverParams,
  trust: CostSource,
): string {
  if (footprints.length === 0) {
    return "L1: no head-to-head footprint had ≥2 configs — add managed rows to compare."
  }
  const parts = footprints.map((f) => {
    const flip = f.toil_flips_winner
      ? ` (toil FLIPS it: pure-$ → ${f.pure_cost_winner.config})`
      : ""
    return `${f.scenario}: TCO-incl-toil winner ${f.tco_incl_toil_winner.config} @ $${f.tco_incl_toil_winner.usd}/mo${flip}`
  })
  return `L1 @ $${params.operator_rate_usd_hr}/hr toil — ${parts.join(" · ")} · trust=${trust}`
}

// ---------------------------------------------------------------------------
// L2 — firehose scale-wall curve, per store
// ---------------------------------------------------------------------------

export type FirehoseStore = "clickhouse" | "postgres"

export interface L2Point {
  collection_count: number
  store: FirehoseStore
  usd_month: number
  latency_p50_ms: number | null
  cost_source: CostSource
}

export interface L2Verdict {
  curve: L2Point[]
  /** ClickHouse vs Postgres $/mo at the largest measured scale (the storage
   *  delta the POC exists to find). null if one store is missing. */
  storage_delta_usd_at_max: number | null
  storage_delta_note: string
  /** Where registration cost/latency would exceed firehose-flat (from the rows'
   *  scale_ceiling annotations). */
  bend_note: string
  trust: CostSource
  summary: string
}

function storeOf(config: IndexingConfig): FirehoseStore | null {
  if (config === "hypersync->clickhouse") return "clickhouse"
  if (config === "hypersync->postgres") return "postgres"
  return null
}

export function computeL2Verdict(rows: IndexingExperimentRow[]): L2Verdict | null {
  const l2 = rows.filter((r) => r.layer === "L2-firehose")
  if (l2.length === 0) return null

  const curve: L2Point[] = l2
    .map((r) => {
      const store = storeOf(r.config)
      if (!store) return null
      return {
        collection_count: r.collection_count,
        store,
        usd_month: round2(microToUsd(r.cost_usd_month_micro)),
        latency_p50_ms: r.latency_p50_ms,
        cost_source: r.cost_source,
      }
    })
    .filter((p): p is L2Point => p !== null)
    .sort((a, b) => a.collection_count - b.collection_count || a.store.localeCompare(b.store))

  // Storage delta at the largest collection_count where BOTH stores have a row.
  const maxCount = Math.max(...curve.map((p) => p.collection_count))
  const atMax = curve.filter((p) => p.collection_count === maxCount)
  const ch = atMax.find((p) => p.store === "clickhouse")
  const pg = atMax.find((p) => p.store === "postgres")
  let storageDelta: number | null = null
  let storageNote: string
  if (ch && pg) {
    storageDelta = round2(pg.usd_month - ch.usd_month)
    const cheaper = storageDelta > 0 ? "ClickHouse" : storageDelta < 0 ? "Postgres" : "neither"
    storageNote = `at ${maxCount} collections: ClickHouse $${ch.usd_month}/mo vs Postgres $${pg.usd_month}/mo — ${cheaper} cheaper by $${Math.abs(storageDelta)}/mo (columnar compression vs row-store).`
  } else {
    storageNote = "storage delta unavailable — need BOTH hypersync->clickhouse and hypersync->postgres rows at the same scale."
  }

  const bendRow = l2.find((r) => r.scale_ceiling && r.scale_ceiling.trim().length > 0)
  const bendNote = bendRow
    ? `registration bend reference: ${bendRow.scale_ceiling}`
    : "no scale_ceiling annotation present — record where registration cost/latency would exceed the firehose-flat curve."

  const trust = weakestCostSource(curve.map((p) => p.cost_source))
  return {
    curve,
    storage_delta_usd_at_max: storageDelta,
    storage_delta_note: storageNote,
    bend_note: bendNote,
    trust,
    summary: `L2 firehose: ${curve.length} points across {${[...new Set(curve.map((p) => p.collection_count))].join(", ")}} collections · ${storageNote} · trust=${trust}`,
  }
}

// ---------------------------------------------------------------------------
// Top-level synthesis
// ---------------------------------------------------------------------------

export interface CrossoverVerdict {
  run_id: string | null
  params: CrossoverParams
  row_count: number
  l1: L1Verdict | null
  l2: L2Verdict | null
  /** Weakest cost_source across EVERYTHING the verdict used. */
  overall_trust: CostSource
  overall_trust_caveat: string
  /** The toil rate is an assumption — flagged so the TCO ranking is never read
   *  as a pure-cost fact. */
  toil_rate_caveat: string
  /** One-paragraph ratify-or-revise statement for the sonar ADR. */
  ratification: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function synthesizeCrossover(
  rows: IndexingExperimentRow[],
  params: CrossoverParams = DEFAULT_CROSSOVER_PARAMS,
): CrossoverVerdict {
  const l1 = computeL1Verdict(rows, params)
  const l2 = computeL2Verdict(rows)
  const allSources: CostSource[] = []
  if (l1) allSources.push(l1.trust)
  if (l2) allSources.push(l2.trust)
  const overallTrust = weakestCostSource(allSources)

  const runIds = [...new Set(rows.map((r) => r.run_id))]
  return {
    run_id: runIds.length === 1 ? runIds[0] : null,
    params,
    row_count: rows.length,
    l1,
    l2,
    overall_trust: overallTrust,
    overall_trust_caveat: trustCaveat(overallTrust),
    toil_rate_caveat: `TCO-incl-toil priced at $${params.operator_rate_usd_hr}/hr operator attention (an ASSUMPTION; setup amortized over ${params.amortize_months}mo). Pure-$ columns are unaffected by this rate.`,
    ratification: buildRatification(l1, l2, overallTrust),
  }
}

function buildRatification(
  l1: L1Verdict | null,
  l2: L2Verdict | null,
  overallTrust: CostSource,
): string {
  const lines: string[] = []
  if (l1 && l1.footprints.length > 0) {
    lines.push(l1.summary)
  } else {
    lines.push("L1 inconclusive: no head-to-head footprint with ≥2 configs.")
  }
  if (l2) {
    lines.push(l2.summary)
  } else {
    lines.push("L2 not yet measured: firehose POC rows absent.")
  }
  const gate =
    overallTrust === "measured"
      ? "RATIFY: every input is measured."
      : `DO NOT RATIFY as settled — overall trust is ${overallTrust}. ${trustCaveat(overallTrust)} Stand up the quoted/projected configs for a measured row before final ratification.`
  lines.push(gate)
  return lines.join(" ")
}
