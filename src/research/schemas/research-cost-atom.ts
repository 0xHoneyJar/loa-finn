// src/research/schemas/research-cost-atom.ts — Contract E #3: the research
// CostAtom shape, incl. the typed-failure variant.
//
// Mirrors `src/cost/cost-atom.ts` (integer micro-USD, append-only, immutable)
// but adds a `prev_hash` HASH CHAIN (the research ledger is a linked list of
// events, per Acceptance Contract A) and the estimate→actual→failure lifecycle
// the spec's §1 + Contract A require. No floats are ever stored: every cost is
// a bigint (micro-USD) and serializes as a decimal STRING in JSONL.

import type { ModelinvRef } from "./modelinv-ref.js"

/** The three seams the lab composes (spec § "two seams + one gate"). */
export type ResearchSensor = "gemini" | "grok" | "dune"

/** An atom's role in the estimate → actual / failure lifecycle (Contract A):
 *  - `budget_reservation` — the ESTIMATED cost, chained + surfaced to the
 *    operator BEFORE the sensor call runs.
 *  - `actual_cost` — the ACTUAL cost, chained AFTER the call, linked back to
 *    its reservation via `reservation_ref`.
 *  - `failure` — a first-class, linked record of a FAILED sensor call. A
 *    failure is NOT a gap in the chain. */
export type ResearchAtomKind = "budget_reservation" | "actual_cost" | "failure"

/** Status discriminant carried alongside `kind` (mirrors the spec's
 *  "status:'failed'" requirement for typed failure atoms). */
export type ResearchAtomStatus = "reserved" | "settled" | "failed"

/** Genesis sentinel for the `prev_hash` chain head. Matches the repo-wide
 *  hash-chain convention (`prev_hash === "genesis"` for the first entry; see
 *  tests/safety/hash-chain-vectors.test.ts and the store audit-trail chain). */
export const GENESIS_HASH = "genesis"

/** The research CostAtom. Records one step of a metered probe.
 *
 *  The spec's §1 minimum — `{sensor, question_hash, tokens|datapoints,
 *  cost_micro, citations_count, grounded, ts}` — plus the Contract-A lifecycle
 *  fields (`kind`/`status`/`reservation_ref`), the Contract-A typed-failure
 *  field (`error_class`), and the Contract-E #4 dedup link (`modelinv_ref`). */
export interface ResearchCostAtom {
  /** ULID — stable atom identity (independent of the hash chain). */
  atom_id: string
  kind: ResearchAtomKind
  status: ResearchAtomStatus
  sensor: ResearchSensor
  /** sha256 hex of the probe question. */
  question_hash: string
  /** Integer micro-USD this atom charges to the RESEARCH ledger. For an
   *  `actual_cost` atom whose LLM spend is metered by MODELINV, the inference
   *  portion is excluded here (0) and lives in `modelinv_ref` — never
   *  double-counted (Contract E #4). */
  cost_micro: bigint
  /** The inference (LLM) portion of `cost_micro`. MUST be 0 when
   *  `modelinv_ref` is set (the dedup invariant). */
  inference_micro: bigint
  /** Number of citations backing the finding (0 ⇒ ungrounded ⇒ INSUFFICIENT). */
  citations_count: number
  /** `citations_count > 0`. The grounding signal (the gate itself lives in the
   *  probe orchestrator; the atom records the fact). */
  grounded: boolean
  /** Unix epoch ms. */
  ts: number
  /** Set on `actual_cost` + `failure` atoms: the `atom_id` of the
   *  `budget_reservation` they settle (the estimate/actual link). */
  reservation_ref: string | null
  /** Set on `failure` atoms: the error class (err.name) of the failed call. */
  error_class: string | null
  /** Set when the LLM spend is already metered by MODELINV (Contract E #4). */
  modelinv_ref: ModelinvRef | null
  /** Provider-resolution honesty (Contract B): what was asked for vs what
   *  Cheval actually served. Null when not an LLM call / not resolved. A probe
   *  whose `provider_resolved !== provider_intended` is a routing fallback, not
   *  evidence the intended provider works. */
  provider_intended: string | null
  provider_resolved: string | null
}

/** Hash-chained WAL envelope (one per JSONL line).
 *
 *  `entry_hash` = sha256 of the canonical JSON of
 *  `{ schema_version, prev_hash, atom }` (bigints as decimal strings, object
 *  keys sorted — the exact canonicalization `src/cost/cost-atom.ts` uses).
 *  `prev_hash` links to the previous envelope's `entry_hash`, or
 *  `GENESIS_HASH` for the first line. Tampering with any stored field breaks
 *  `entry_hash`; deleting/reordering a line breaks the `prev_hash` link. */
export interface ResearchAtomEnvelope {
  schema_version: 1
  prev_hash: string
  /** The canonicalized atom (bigint cost fields stored as decimal strings). */
  atom: Record<string, unknown>
  entry_hash: string
}
