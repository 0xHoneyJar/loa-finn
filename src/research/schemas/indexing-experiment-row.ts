// src/research/schemas/indexing-experiment-row.ts — the Layer-1 TCO + Layer-2
// firehose experiment row (epic bd-idx-tco-exp-s7r5).
//
// This is the artifact every config × scale-point produces. It settles the
// CONTESTED sonar indexing figures ($133 lived / $84 PRD / $70 Envio) by
// recording the real number ALONGSIDE its provenance — because those figures
// exist precisely BECAUSE TCO-including-toil was never measured.
//
// It mirrors the `src/research` ledger idiom EXACTLY (research-cost-atom.ts):
//   · money is integer micro-USD (bigint), serialized as decimal STRINGS — never
//     a float (the exact discipline that prevents the $84/$300 rounding-vibe).
//   · the row is wrapped in a hash-chained, append-only envelope (prev_hash +
//     entry_hash); tampering with any field, or deleting/reordering a line, is
//     DETECTABLE on replay.
//   · validation is an `assert*` mechanism, not a sentence.
//
// DELIBERATE DIVERGENCE FROM THE SPEC SHAPE (and why):
//   spec field          → here                          why
//   cost_usd_month:num  → cost_usd_month_micro:bigint   no floats reach a ledger
//   toil_hours_setup    → toil_minutes_setup:int        integer minutes, no float
//   (added)             → toil_minutes_per_incident:int you cannot PRICE incident
//                                                        toil without time/incident
//   (added)             → cost_source                   the load-bearing tag:
//                                                        measured > vendor-quote >
//                                                        projected. NEVER present a
//                                                        projection as measured.
//   (added)             → cost_basis, retrieved_ts      Ken-Thompson lens: every
//                                                        number cites HOW + WHEN it
//                                                        was obtained (trust only
//                                                        what you can reproduce).
//   (added)             → scenario                      lets one config carry 1x /
//                                                        2x / 5x footprint + the
//                                                        as-billed vs productive-
//                                                        clean decomposition.

// ---------------------------------------------------------------------------
// Discriminants
// ---------------------------------------------------------------------------

/** The architectural fork the sonar ADR settled in shape (not substrate):
 *  registration-based curated indexing vs firehose-by-signature → warehouse. */
export type IndexingLayer = "L1-curated" | "L2-firehose"

/** The configs under comparison. Ponder/Envio/Goldsky sit on the SAME side of
 *  the fork (registration); the hypersync->* pair is the firehose POC. */
export type IndexingConfig =
  | "ponder-railway" // the lived sovereign baseline (freeside-sonar)
  | "envio-hyperindex" // managed, the thing sovereignty walked away from
  | "goldsky" // managed, quote comparison
  | "hypersync->clickhouse" // L2 firehose POC, columnar warehouse arm
  | "hypersync->postgres" // L2 firehose POC, row-store arm (the storage delta)

/** The ONE load-bearing tag. Trust ordering: measured > vendor-quote > projected.
 *  A crossover verdict inherits the WEAKEST cost_source of the rows it rests on
 *  (see indexing-crossover.ts) — that is the Ken-Thompson invariant made code.
 *  - `measured`     — a real bill / a real run on the real footprint.
 *  - `vendor-quote` — a current published price for the identical footprint
 *                     (cite the URL + retrieved_ts; a quote is not a run).
 *  - `projected`    — a model/extrapolation. NEVER rendered as measured. */
export type CostSource = "measured" | "vendor-quote" | "projected"

export const COST_SOURCE_TRUST: Record<CostSource, number> = {
  measured: 3,
  "vendor-quote": 2,
  projected: 1,
}

/** Valid value sets — used by the assert validator so a typo'd config or an
 *  unknown layer fails at write time, not silently at synthesis. */
export const INDEXING_LAYERS: readonly IndexingLayer[] = ["L1-curated", "L2-firehose"]
export const INDEXING_CONFIGS: readonly IndexingConfig[] = [
  "ponder-railway",
  "envio-hyperindex",
  "goldsky",
  "hypersync->clickhouse",
  "hypersync->postgres",
]
export const COST_SOURCES: readonly CostSource[] = ["measured", "vendor-quote", "projected"]

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** One (config × scale-point) measurement. The experiment's unit of record. */
export interface IndexingExperimentRow {
  // -- identity + context ----------------------------------------------------
  /** ULID — stable row identity, independent of the hash chain. */
  row_id: string
  /** Groups all rows of one experiment pass (so a re-run is a distinct cohort). */
  run_id: string
  /** ISO date (YYYY-MM-DD) the number was obtained/observed. */
  date: string
  /** Free-form scale/decomposition label: "as-billed", "productive-clean",
   *  "2x-footprint", "5x-footprint", "scale-100", "scale-10k", … — lets one
   *  config carry the footprint curve the crossover needs. */
  scenario: string

  // -- classification --------------------------------------------------------
  layer: IndexingLayer
  config: IndexingConfig
  /** EVM chain id the row measures (e.g. 80094 Berachain mainnet). */
  chain: number
  /** Number of contracts/collections in this scenario's footprint. */
  collection_count: number
  /** Total indexed events in this scenario's footprint (event density, not
   *  collection breadth — the load that actually drives sonar's bill). */
  event_count: number

  // -- cost (integer micro-USD, NEVER float) ---------------------------------
  /** Monthly infra cost in micro-USD. $133.21/mo ⇒ 133_210_000n. */
  cost_usd_month_micro: bigint
  /** The load-bearing provenance tag (measured/vendor-quote/projected). */
  cost_source: CostSource

  // -- toil (FIRST-CLASS cost — the operator's stated #1 pain) ----------------
  /** One-time stand-up cost, integer minutes (amortized in the crossover). */
  toil_minutes_setup: number
  /** Manual interventions in a 30d window (caps/resizes/crashes/cleanups).
   *  0 for a managed option — that zero is the whole point. */
  toil_incidents_30d: number
  /** Avg minutes spent per intervention. Without this the incident count cannot
   *  be PRICED into TCO. 0 when there are no incidents. */
  toil_minutes_per_incident: number

  // -- performance (null = NOT captured this pass; distinct from a real 0) -----
  latency_p50_ms: number | null
  freshness_lag_s: number | null

  // -- governance ------------------------------------------------------------
  /** 1 = self-host (sovereign), 0 = managed. */
  sovereignty: 0 | 1
  /** Where this config breaks (e.g. "Postgres RAM at ~Nx events"). */
  scale_ceiling: string

  // -- provenance (Ken-Thompson / Satoshi: trust only what you reproduce) -----
  /** HOW the number was derived: invoice ref, pricing URL, projection formula. */
  cost_basis: string
  /** Unix epoch ms a vendor-quote price was fetched. null for measured-from-
   *  invoice (the invoice date lives in `date`). */
  retrieved_ts: number | null
  /** Anything a future reader needs to reproduce or trust this row. */
  notes: string
}

/** Hash-chained WAL envelope (one per JSONL line). Identical shape + meaning to
 *  ResearchAtomEnvelope: entry_hash = sha256 of canonical
 *  { schema_version, prev_hash, row } (bigints as decimal strings, keys sorted);
 *  prev_hash links to the prior envelope's entry_hash, GENESIS_HASH for line 1. */
export interface IndexingRowEnvelope {
  schema_version: 1
  prev_hash: string
  /** The canonicalized row (bigint money stored as a decimal string). */
  row: Record<string, unknown>
  entry_hash: string
}

// ---------------------------------------------------------------------------
// Validators (assert mechanisms, mirroring assertAtomIntegerMicro)
// ---------------------------------------------------------------------------

/** Throws unless `cost_usd_month_micro` is a non-negative bigint. Float
 *  contamination (`133.21 as unknown as bigint`) fails HERE, not at read time. */
export function assertRowIntegerMicro(row: IndexingExperimentRow): void {
  const v = row.cost_usd_month_micro
  if (typeof v !== "bigint" || v < 0n) {
    throw new Error("indexing-row integer-micro: cost_usd_month_micro must be a non-negative bigint")
  }
}

/** Throws unless every enum-typed field holds a known value and the integer
 *  fields are non-negative integers. Catches a typo'd config/layer/cost_source
 *  (which would silently corrupt synthesis) at write time. */
export function assertRowValid(row: IndexingExperimentRow): void {
  assertRowIntegerMicro(row)
  if (!INDEXING_LAYERS.includes(row.layer)) {
    throw new Error(`indexing-row: unknown layer "${row.layer}"`)
  }
  if (!INDEXING_CONFIGS.includes(row.config)) {
    throw new Error(`indexing-row: unknown config "${row.config}"`)
  }
  if (!COST_SOURCES.includes(row.cost_source)) {
    throw new Error(`indexing-row: unknown cost_source "${row.cost_source}"`)
  }
  if (row.sovereignty !== 0 && row.sovereignty !== 1) {
    throw new Error(`indexing-row: sovereignty must be 0 or 1, got ${row.sovereignty}`)
  }
  const intFields: Array<[string, number]> = [
    ["collection_count", row.collection_count],
    ["event_count", row.event_count],
    ["toil_minutes_setup", row.toil_minutes_setup],
    ["toil_incidents_30d", row.toil_incidents_30d],
    ["toil_minutes_per_incident", row.toil_minutes_per_incident],
    ["chain", row.chain],
  ]
  for (const [name, n] of intFields) {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`indexing-row: ${name} must be a non-negative integer, got ${n}`)
    }
  }
  // Performance fields are nullable (null = not captured); if present, finite ≥ 0.
  const perfFields: Array<[string, number | null]> = [
    ["latency_p50_ms", row.latency_p50_ms],
    ["freshness_lag_s", row.freshness_lag_s],
  ]
  for (const [name, n] of perfFields) {
    if (n !== null && (!Number.isFinite(n) || n < 0)) {
      throw new Error(`indexing-row: ${name} must be null or a finite non-negative number, got ${n}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Display-only helpers (NEVER use the float form for storage or hashing)
// ---------------------------------------------------------------------------

/** Convert integer micro-USD to a float dollar amount — DISPLAY ONLY. */
export function microToUsd(micro: bigint): number {
  return Number(micro) / 1_000_000
}

/** Convert a float dollar amount to integer micro-USD for STORAGE. Rounds to the
 *  nearest micro (the only place a float→int crossing is allowed; it happens at
 *  ingest, never inside the ledger). */
export function usdToMicro(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000))
}
