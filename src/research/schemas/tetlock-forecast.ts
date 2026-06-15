// src/research/schemas/tetlock-forecast.ts — Contract E #2: the TETLOCK
// calibration record. Foundational for calibration; carries a NULLABLE
// `attestation` field (the reserved ERC-8004 shape) so the Echelon
// reputation/calibration seam (regime 13) stays forward-compatible.
//
// "Wire, don't build" (spec § Echelon seam): V1 emits the record with
// `attestation: null`. TETLOCK's Brier/calibration scores ARE the reputation
// signal Echelon's regime 13 would later consume on-chain via ERC-8004.

/** Reserved ERC-8004 (trustless-agent reputation registry) attestation shape.
 *  NULL in V1 — present only so the on-chain reputation seam is forward
 *  compatible (loa-finn#27 finnNFT constellation: ERC-6551 TBA + ERC-8004
 *  reputation + x402 + Lit). Do NOT populate in V1. */
export interface Erc8004Attestation {
  /** On-chain reputation registry contract address. */
  registry: string
  /** The agent's identity (e.g. its ERC-6551 token-bound account). */
  agent_id: string
  /** Calibration score as integer parts-per-million (avoids stored floats). */
  score_ppm: number
  attestation_uri: string
  signature: string
}

/** Resolution outcomes — mirror the spine's settle verdicts (HELD / FALSIFIED /
 *  INSUFFICIENT) in lowercase. */
export type ForecastOutcome = "held" | "falsified" | "insufficient"

/** The horizon a forecast is registered for (sprint:corpus-a T0b / SDD DD-3′).
 *  `discovery` is the present-tense realness bet; `survival_*` are the forward
 *  re-settle bets. A re-settle MUST be Brier-scored against the forecast for ITS
 *  OWN horizon — never the discovery `p` (scoring across horizons is statistically
 *  invalid; discovery-realness and N-day-survival are different events). */
export type ForecastHorizon = "discovery" | "survival_7d" | "survival_30d" | "survival_90d"

/** A TETLOCK forecast: a belief turned into a calibrated, scored, falsifiable
 *  forecast (the Calibration Desk · the Ledger of Bets). Probabilities and
 *  scores are integer parts-per-million — no stored floats, consistent with the
 *  CostAtom integer-micro discipline. */
export interface TetlockForecast {
  forecast_id: string
  /** sha256 hex of the question — joins to the probe + CostAtom. */
  question_hash: string
  /** Which horizon this forecast scores (DD-3′). A settle for horizon H must
   *  resolve the forecast registered for (question_hash, H), never another. */
  horizon: ForecastHorizon
  /** Claimed probability the belief holds, integer parts-per-million (0..1e6). */
  probability_ppm: number
  /** Pre-registered resolution criterion (PLATT's crucial-experiment bar) — the
   *  deterministic test that will settle the bet. */
  resolution_criterion: string
  /** Outside-view base rate, integer ppm. Null until established. */
  base_rate_ppm: number | null
  created_ts: number
  /** Settlement timestamp; null until a deterministic instrument resolves it. */
  resolved_ts: number | null
  outcome: ForecastOutcome | null
  /** Brier score of this forecast, integer parts-per-million (0 = perfect).
   *  Null until resolved. */
  brier_ppm: number | null
  /** Reserved ERC-8004 attestation — NULL in V1 (the Echelon seam). */
  attestation: Erc8004Attestation | null
}
