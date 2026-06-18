// src/research/schemas/spine-event.ts — Contract E #1: the `claimed`-tier
// probe spine event — the interop contract between probe authors, settlement,
// and calibration (the Ledger of Bets).
//
// GROUNDING: the existing spine (observatory/src/lib/spine-data.json) records
// events with `kind: register | probe | settle`, `id`, `label`, `source`,
// optional `tier`/`verdict`/`delta`. This schema is the PROBE-event refinement
// the lab emits: a metered, cited, `claimed`-tier probe. Contract C migrates
// the spine from flat JSON to a hash-chained JSONL append; this event therefore
// carries a `prev_hash` so it is forward-compatible with that migration (the
// migration itself is a separate task — this is the shape only).

import type { ResearchSensor } from "./research-cost-atom.js"

/** A citation backing a claimed finding (Contract D's validation shape). V1
 *  STORES these fields; the grounding gate in the probe orchestrator ENFORCES
 *  them (linkrot: http_status must be 2xx · circular: citation domain ≠
 *  question-source domain · freshness: vs freshness_max_age). A `confidence:
 *  "low"` citation is still INSUFFICIENT for a high-stakes probe. */
export interface Citation {
  url: string
  /** When the citation was fetched (unix epoch ms) — freshness input. */
  retrieved_ts: number
  /** HTTP status at retrieval (linkrot gate: must be 2xx). Null if unfetched. */
  http_status: number | null
  source_type: string | null
  claim_support: string | null
  confidence: "low" | "medium" | "high" | null
}

/** A `claimed`-tier probe event on the spine. The finding is `claimed` (a notch
 *  above speculation, below verified) until a DETERMINISTIC instrument settles
 *  it (on-chain / test / market P&L — never an LLM). */
export interface ResearchSpineEvent {
  kind: "probe"
  tier: "claimed"
  sensor: ResearchSensor
  /** sha256 hex of the probe question — joins to the CostAtom + forecast. */
  question_hash: string
  finding: string
  citations: Citation[]
  /** `atom_id` of the `actual_cost` (or `failure`) research CostAtom that
   *  metered this probe. A probe without a `cost_atom_ref` didn't happen — the
   *  one hard gate, made a required field. */
  cost_atom_ref: string
  /** Unix epoch ms. */
  ts: number
  /** Hash-chain link to the previous spine event (Contract C: spine → JSONL),
   *  or the genesis sentinel for the first event. */
  prev_hash: string
}
