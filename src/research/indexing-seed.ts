// src/research/indexing-seed.ts — the canonical, provenance-tagged SOURCE for
// the indexing TCO experiment rows (epic bd-idx-tco-exp-s7r5).
//
// The ledger JSONL is a GENERATED artifact: `pnpm indexing:seed` regenerates it
// from this module, deterministically. Row ids are content-derived (NOT random
// ULIDs) so re-seeding produces a byte-identical, hash-stable ledger — "anyone
// can re-run a config and get the row" (the spec's reproducibility rule).
//
// EVERY row carries its provenance in `cost_basis` + `notes`. The `cost_source`
// tag is load-bearing: measured > vendor-quote > projected. Numbers below are
// grounded in:
//   · the sonar ADR (2026-06-15-indexing-strategy-reframe-adr.md) — the lived
//     Railway invoice decomposition ($133.21 total, ~$58 productive-clean).
//   · sonar-api/config.yaml — Berachain Mainnet chain id 80094, ~93 curated
//     contracts (96 raw address entries), event density (Action 2.07M +
//     BgtBoostEvent 1.47M per the ADR).
//   · vendor pricing pages (vendor-quote rows) — cited inline with retrieved date.
//   · projection formulae (projected rows) — the formula is in `cost_basis`.

import type { IndexingExperimentRow } from "./schemas/indexing-experiment-row.js"
import { usdToMicro } from "./schemas/indexing-experiment-row.js"

/** One experiment pass. Re-running with a new RUN_ID makes a distinct cohort. */
export const RUN_ID = "idx-tco-exp-2026-06-16"

const CHAIN_BERA = 80094
const FOOTPRINT_CONTRACTS = 93 // ADR "~93 curated"; config.yaml has 96 address entries
const FOOTPRINT_EVENTS = 3_540_000 // ≥ : Action 2.07M + BgtBoostEvent 1.47M (two dominant types per ADR); total is higher

/** Content-derived, stable row id (NOT a random ULID) — keeps the ledger
 *  byte-reproducible across re-seeds. */
export function deterministicRowId(config: string, scenario: string): string {
  return `${RUN_ID}::${config}::${scenario}`
}

/** Build a row with the experiment's shared defaults; overrides win. */
function mk(over: Partial<IndexingExperimentRow> & Pick<IndexingExperimentRow, "config" | "scenario" | "layer" | "cost_source">): IndexingExperimentRow {
  return {
    row_id: deterministicRowId(over.config, over.scenario),
    run_id: RUN_ID,
    date: "2026-06-16",
    chain: CHAIN_BERA,
    collection_count: FOOTPRINT_CONTRACTS,
    event_count: FOOTPRINT_EVENTS,
    cost_usd_month_micro: 0n,
    toil_minutes_setup: 0,
    toil_incidents_30d: 0,
    toil_minutes_per_incident: 0,
    latency_p50_ms: null,
    freshness_lag_s: null,
    sovereignty: 0,
    scale_ceiling: "",
    cost_basis: "",
    retrieved_ts: null,
    notes: "",
    ...over,
  }
}

// ===========================================================================
// MEASURED rows — the honest denominator (cost_source: "measured")
// ===========================================================================

const MEASURED_ROWS: IndexingExperimentRow[] = [
  // The lived baseline AS BILLED — what freeside-sonar actually costs today,
  // incl. the ~$50/mo of removable dead-waste + migration-tax. This is the
  // reference, not the architectural comparison (only Ponder has an "as-billed").
  mk({
    config: "ponder-railway",
    scenario: "as-billed",
    layer: "L1-curated",
    cost_source: "measured",
    cost_usd_month_micro: usdToMicro(133.21),
    sovereignty: 1,
    toil_minutes_setup: 480, // ~8h initial stand-up (estimate; baseline predates a live toil log)
    toil_incidents_30d: 3, // MEASURED: eRPC Postgres cap→100GB resize · green-v3 crash-loop · #71 orphan cleanup
    toil_minutes_per_incident: 60, // ESTIMATE — no stopwatch log for the baseline; E3 logs future incidents live
    scale_ceiling: "Postgres RAM dominates (~$74/mo); caps→resizes as event density grows",
    cost_basis: "freeside-sonar Railway dashboard 2026-06-15 (ADR §'verified cost reality'): $133.21 total = ~$58 productive + ~$25 dead-waste + ~$25 migration-tax + Postgres-RAM-dominated.",
    notes: "AS-BILLED = today's full bill incl. ~$50/mo removable waste (bd-4kf cutover + real orphan cleanup recover it INDEPENDENT of the architecture decision). cost_source=measured refers to the $/mo (real invoice). toil INCIDENT COUNT measured (3 named); per-incident MINUTES estimated post-hoc.",
  }),

  // The fair architectural baseline at 1x footprint: the CLEAN productive cost,
  // apples-to-apples vs a managed option that carries no dead-waste.
  mk({
    config: "ponder-railway",
    scenario: "1x",
    layer: "L1-curated",
    cost_source: "measured",
    cost_usd_month_micro: usdToMicro(58),
    sovereignty: 1,
    toil_minutes_setup: 480,
    toil_incidents_30d: 3, // stack-level reality; 1 of 3 (#71 cleanup) disappears once waste is removed
    toil_minutes_per_incident: 60,
    scale_ceiling: "Postgres RAM steps up with event density; the resize treadmill is the real ceiling",
    cost_basis: "ADR invoice decomposition: ~$58 productive-clean (vRR1 + green-v3 + belt-hasura-green + erpc + belt-gateway). The clean cost the stack holds at ONLY with continuous toil.",
    notes: "PRODUCTIVE-CLEAN 1x baseline = what sovereign-Ponder costs without the removable waste; ≈ Envio's flat ~$70 BEFORE toil is priced. This is the head-to-head row vs managed at 1x.",
  }),
]

// ===========================================================================
// VENDOR-QUOTE rows (cost_source: "vendor-quote") — filled from current pricing
// pages with retrieved date. Pending the L1 pricing research.
// ===========================================================================

const VENDOR_QUOTE_ROWS: IndexingExperimentRow[] = [
  // Envio at 1x. NOTE: Envio's CURRENT dollar pricing is UNPUBLISHED (usage-tiers,
  // quote-via-Discord — L1 research 2026-06-16). The only Envio figure that exists
  // is the operator's lived ~$70/mo (ADR, "lived-authoritative, re-confirm"). It is
  // NOT reproducible-now ⇒ tagged vendor-quote, NOT measured. This is the honest
  // ceiling on what we know about Envio without standing it up.
  mk({
    config: "envio-hyperindex",
    scenario: "1x",
    layer: "L1-curated",
    cost_source: "vendor-quote",
    cost_usd_month_micro: usdToMicro(70),
    sovereignty: 0,
    toil_minutes_setup: 240, // ~4h config.yaml + schema + handlers for 93 contracts (ESTIMATE)
    toil_incidents_30d: 0, // managed = zero firefighting (the whole point)
    toil_minutes_per_incident: 0,
    freshness_lag_s: null, // "minimal latency / real-time" published but only qualitative
    scale_ceiling: "event-throughput tier (cost scales with event density, not contract count); exact $ gated behind a sales quote",
    cost_basis: "operator-recollected lived Envio bill ~$70/mo flat (ADR, lived-authoritative). CURRENT Envio pricing UNPUBLISHED / Discord-quote-gated (envio.dev/pricing + hosted-service-billing, retrieved 2026-06-16) — could NOT re-confirm. Tagged vendor-quote (not measured) because it is not reproducible now. Berachain FIRST-CLASS HyperSync (chain 80094) verified.",
    notes: "MANAGED ⇒ 0 toil. STAND UP via the runbook to upgrade $70 → measured + confirm the current tier. The operator's whole thesis (Envio was ~$70 & zero-attention) rests on re-confirming this.",
  }),

  // Goldsky at 1x — DERIVED from PUBLISHED unit rates (the rates are real; the
  // $/mo for our exact footprint is my derivation, not a vendor quote).
  mk({
    config: "goldsky",
    scenario: "1x",
    layer: "L1-curated",
    cost_source: "vendor-quote",
    cost_usd_month_micro: usdToMicro(73),
    sovereignty: 0,
    toil_minutes_setup: 330, // ~5.5h author/migrate subgraph for 93 contracts (ESTIMATE)
    toil_incidents_30d: 0,
    toil_minutes_per_incident: 0,
    freshness_lag_s: null, // "real-time" Mirror, not quantified on pricing page
    scale_ceiling: "entity count ($4/100k beyond 100k free) + Mirror records-written ($1/100k beyond 1M) — a high-cardinality schema inflates cost fast",
    cost_basis: "DERIVED from published unit rates (goldsky.com/pricing, docs.goldsky.com/pricing/summary, retrieved 2026-06-16): subgraph compute ~$36.50/mo/worker + storage $4/100k entities. Point est ~$73/mo @ ~1M entities; RANGE $37–170/mo. The load-bearing unknown is ENTITY count (schema-dependent), NOT the 3.5M event count. Berachain dedicated partnership verified.",
    notes: "MANAGED ⇒ 0 toil. Published rates are real; the $/mo is my derivation, not a Goldsky quote for this footprint. Free tier is a dev allowance, insufficient for prod.",
  }),
]

// ===========================================================================
// PROJECTED rows (cost_source: "projected") — extrapolations; formula in
// cost_basis. NEVER rendered as measured. Pending L1 2x/5x + L2 firehose research.
// ===========================================================================

const ETH = 1 // L2 firehose POC runs on Ethereum — the RICHEST NFT chain (most
// collections/events) = the worst-case scale stress test. Berachain (the L1
// footprint) is a small subset; if the firehose is cheap on Ethereum it is cheap
// anywhere. "one chain, enough to find the curve" (the spec).

/** L2 storage-line $/mo = events × bytes/row × storage-rate. Inputs are real
 *  (published rates + Dune-measured event counts); the $/mo is the extrapolation
 *  → cost_source "projected". ClickHouse ~100 B/row compressed (anchored to
 *  CryptoHouse 6.11× on real on-chain token transfers + ClickBench ~99 B/row);
 *  Postgres ~600 B/row (~6× the columnar figure — the conservative CH:PG ratio). */
const CH_BYTES_PER_ROW = 100
const PG_BYTES_PER_ROW = 600
const CH_USD_PER_GB_MONTH = 25.3 / 1000 // $25.30/TB-mo (ClickHouse Cloud Basic/Scale)
const PG_USD_PER_GB_MONTH = 0.15 // Railway volume $0.15/GB-mo (RAM-to-serve is separate, see notes)

function storageUsdMonth(events: number, bytesPerRow: number, usdPerGbMonth: number): number {
  const gb = (events * bytesPerRow) / 1e9
  return gb * usdPerGbMonth
}

/** (collection_count, transfer events) — events MEASURED via Dune `nft.transfers`
 *  (ethereum), execution 2026-06-16. Top-100k already = 98.8% of all transfers;
 *  ~406k collections is the WHOLE Ethereum NFT universe. */
const L2_SCALE_POINTS: Array<{ scenario: string; cols: number; events: number }> = [
  { scenario: "scale-100", cols: 100, events: 69_080_073 },
  { scenario: "scale-10k", cols: 10_000, events: 264_245_632 },
  { scenario: "scale-100k", cols: 100_000, events: 391_361_294 },
  { scenario: "scale-all", cols: 405_846, events: 396_293_970 },
]

const L2_FIREHOSE_ROWS: IndexingExperimentRow[] = L2_SCALE_POINTS.flatMap((p) => {
  const ceiling =
    "Ethereum has only ~406k NFT collections / ~396M lifetime Transfer events (~40GB columnar) — 'millions of collections' does NOT exist on one chain; the firehose has no cost wall here. Registration's ceiling is OPERATIONAL (per-contract enumeration), not cost."
  const basisCommon = `event_count MEASURED (Dune nft.transfers ethereum, exec 2026-06-16, query 7737010); $/mo PROJECTED = ${"events"} × bytes/row × storage-rate. STORAGE LINE ONLY — compute/RAM is separate and is the larger serving cost (favors columnar).`
  return [
    mk({
      config: "hypersync->clickhouse",
      scenario: p.scenario,
      layer: "L2-firehose",
      cost_source: "projected",
      chain: ETH,
      collection_count: p.cols,
      event_count: p.events,
      cost_usd_month_micro: usdToMicro(storageUsdMonth(p.events, CH_BYTES_PER_ROW, CH_USD_PER_GB_MONTH)),
      sovereignty: 0,
      scale_ceiling: ceiling,
      cost_basis: `ClickHouse Cloud storage $25.30/TB-mo (getbeton/pulse/improvado 2026-05) × ~100 B/row compressed (CryptoHouse 6.11× real on-chain). ${basisCommon}`,
      notes: "ClickHouse columnar arm. HyperSync extraction $0 marginal at POC scale (self-host + free/cheap token); production rate UNPUBLISHED (sales-quote). Query latency not measured (null).",
    }),
    mk({
      config: "hypersync->postgres",
      scenario: p.scenario,
      layer: "L2-firehose",
      cost_source: "projected",
      chain: ETH,
      collection_count: p.cols,
      event_count: p.events,
      cost_usd_month_micro: usdToMicro(storageUsdMonth(p.events, PG_BYTES_PER_ROW, PG_USD_PER_GB_MONTH)),
      sovereignty: 1,
      scale_ceiling: ceiling,
      cost_basis: `Railway Postgres volume $0.15/GB-mo (makerkit @railway/pricing 2026-05) × ~600 B/row (~6× columnar). ${basisCommon} The REAL Postgres cost at scale is RAM ($10/GB-mo) to hold a 200+GB row-store working set — NOT in this storage line.`,
      notes: "Postgres row-store arm. Storage line ~6× ClickHouse; the hidden cost is RAM-to-serve. Query latency not measured (null).",
    }),
  ]
})

// L1 footprint curve at 2x / 5x — PROJECTED. Shows the TREND, not settled $:
//   · Ponder (sovereign): RAM-dominated cost grows with event density AND the
//     toil treadmill (caps/resizes/firefighting) worsens with scale. Formula:
//     ponder($) ≈ 23 fixed + 35×N (RAM scales ~linearly; the conservative upper
//     bound — caching helps, but RAM caps force step-resizes, which IS the toil).
//   · Envio (managed): usage-based, scaled from the (unverified) ~$70 base ×
//     throughput; 0 toil. Doubly-uncertain (projection on an unconfirmed base).
const L1_PROJECTIONS: Array<{ mult: number; scenario: string }> = [
  { mult: 2, scenario: "2x" },
  { mult: 5, scenario: "5x" },
]

const L1_PROJECTED_ROWS: IndexingExperimentRow[] = L1_PROJECTIONS.flatMap(({ mult, scenario }) => {
  const cols = FOOTPRINT_CONTRACTS * mult
  const events = FOOTPRINT_EVENTS * mult
  const ponderUsd = 23 + 35 * mult
  const envioUsd = 70 * mult
  const ponderIncidents = mult === 2 ? 4 : 6 // sub-linear toil growth (defensible)
  return [
    mk({
      config: "ponder-railway",
      scenario,
      layer: "L1-curated",
      cost_source: "projected",
      chain: CHAIN_BERA,
      collection_count: cols,
      event_count: events,
      cost_usd_month_micro: usdToMicro(ponderUsd),
      sovereignty: 1,
      toil_minutes_setup: 480 * mult, // more contracts to register
      toil_incidents_30d: ponderIncidents,
      toil_minutes_per_incident: 60,
      scale_ceiling: "Postgres RAM cap → resize treadmill; the toil grows faster than the dollars",
      cost_basis: `PROJECTED: ponder($) ≈ 23 fixed + 35×${mult} = $${ponderUsd}/mo (RAM scales ~linearly with event density; conservative upper bound). Toil scales with the resize treadmill (${ponderIncidents} incidents/mo @ 60min). Anchored to the measured 1x productive-clean $58.`,
      notes: `Sovereign at ${scenario}: the story is the TOIL curve, not the dollar curve. Directional only.`,
    }),
    mk({
      config: "envio-hyperindex",
      scenario,
      layer: "L1-curated",
      cost_source: "projected",
      chain: CHAIN_BERA,
      collection_count: cols,
      event_count: events,
      cost_usd_month_micro: usdToMicro(envioUsd),
      sovereignty: 0,
      toil_minutes_setup: 240, // one-time, doesn't grow much (managed)
      toil_incidents_30d: 0,
      toil_minutes_per_incident: 0,
      scale_ceiling: "usage tier steps up with throughput; still 0 operator toil",
      cost_basis: `PROJECTED (DOUBLY uncertain): envio($) ≈ 70×${mult} = $${envioUsd}/mo, scaled from the UNVERIFIED ~$70 lived base × throughput. Envio pricing unpublished. Directional only.`,
      notes: `Managed at ${scenario}: dollars may rise with throughput, but toil stays 0 — that gap is the whole finding.`,
    }),
  ]
})

const PROJECTED_ROWS: IndexingExperimentRow[] = [
  ...L1_PROJECTED_ROWS,
  ...L2_FIREHOSE_ROWS,
]

/** All experiment rows, in chain order (measured → quote → projected). */
export function seedRows(): IndexingExperimentRow[] {
  return [...MEASURED_ROWS, ...VENDOR_QUOTE_ROWS, ...PROJECTED_ROWS]
}
