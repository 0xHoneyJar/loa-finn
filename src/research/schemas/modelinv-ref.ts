// src/research/schemas/modelinv-ref.ts — Contract E #4: the MODELINV ↔
// research-atom reference / dedup contract.
//
// GROUNDING (do not invent a file): "MODELINV" in this repo is the cheval
// metering cost-ledger. It is written by
//   .claude/adapters/loa_cheval/metering/ledger.py :: create_ledger_entry()
// to `.run/cost-ledger.jsonl` (one JSONL line per metered model-invoke,
// fcntl.flock-serialized). Its unique key is `request_id` (e.g. "req-<hex12>");
// cost is ALREADY integer micro-USD there (the Python `cost_micro_usd` int).
//
// The dedup law: a Cheval-routed LLM call is metered by MODELINV. The research
// atom REFERENCES that entry instead of re-charging the inference spend, so a
// single LLM call's dollars appear EXACTLY ONCE across the two ledgers
// (Contract E #4, spend-accuracy acceptance criterion).

/** Default path of the MODELINV (cheval metering) ledger this references.
 *  Source: ledger.py default `ledger_path` = ".run/cost-ledger.jsonl". */
export const MODELINV_LEDGER_PATH = ".run/cost-ledger.jsonl"

/** A row in the MODELINV (cheval metering) ledger. Mirrors the fields of the
 *  Python `create_ledger_entry()` shape that the dedup contract depends on;
 *  other fields (latency_ms, pricing_source, phase_id, …) are carried by the
 *  Python writer but irrelevant to spend reconciliation. `cost_micro_usd` is an
 *  integer (micro-USD) by construction on the Python side. */
export interface ModelinvEntry {
  request_id: string
  trace_id: string
  agent: string
  provider: string
  model: string
  tokens_in: number
  tokens_out: number
  tokens_reasoning: number
  cost_micro_usd: number
  ts: string
}

/** A link from a research CostAtom to the MODELINV entry that already metered
 *  its LLM spend.
 *
 *  INVARIANT: when a research atom carries a `modelinv_ref`, the atom's own
 *  `inference_micro` MUST be 0 — the inference dollars live in MODELINV, never
 *  double-charged on the research ledger. `cost_micro` here mirrors the
 *  referenced entry's `cost_micro_usd` as an integer-micro bigint, so a reader
 *  with only the research JSONL can still total the call's true spend without
 *  re-reading MODELINV. */
export interface ModelinvRef {
  /** Where the MODELINV entry lives (default `MODELINV_LEDGER_PATH`). */
  ledger_path: string
  /** The MODELINV entry's `request_id` — the join key for dedup. */
  request_id: string
  /** The MODELINV entry's `trace_id`. */
  trace_id: string
  /** Mirror of the entry's `cost_micro_usd`, as integer micro-USD (bigint). */
  cost_micro: bigint
}
