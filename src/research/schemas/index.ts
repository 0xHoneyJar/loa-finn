// src/research/schemas/index.ts — the four V1 schemas (Acceptance Contract E).
// One import surface for probe authors, settlement, and calibration.
//
//   1. spine-event       — the `claimed`-tier probe (ResearchSpineEvent)
//   2. tetlock-forecast  — the calibration record (nullable ERC-8004 attestation)
//   3. research-cost-atom — the research CostAtom incl. the typed-failure variant
//   4. modelinv-ref      — the MODELINV ↔ research-atom dedup link

export type { ResearchSpineEvent, Citation } from "./spine-event.js"
export type {
  TetlockForecast,
  Erc8004Attestation,
  ForecastOutcome,
  ForecastHorizon,
} from "./tetlock-forecast.js"
export {
  GENESIS_HASH,
} from "./research-cost-atom.js"
export type {
  ResearchCostAtom,
  ResearchAtomEnvelope,
  ResearchSensor,
  ResearchAtomKind,
  ResearchAtomStatus,
} from "./research-cost-atom.js"
export { MODELINV_LEDGER_PATH } from "./modelinv-ref.js"
export type { ModelinvRef, ModelinvEntry } from "./modelinv-ref.js"
