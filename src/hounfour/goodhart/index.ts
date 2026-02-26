// src/hounfour/goodhart/index.ts — Goodhart Protection Engine (SDD §4.1, cycle-034)
//
// Re-exports all Goodhart protection components for convenient import:
//   import { TemporalDecayEngine, ExplorationEngine, ... } from './goodhart'

export { TemporalDecayEngine } from "./temporal-decay.js"
export type { TemporalDecayConfig, EMAState, EMAKey } from "./temporal-decay.js"

export { ExplorationEngine } from "./exploration.js"
export type { ExplorationConfig, ExplorationDecision } from "./exploration.js"

export { CalibrationEngine } from "./calibration.js"
export type { CalibrationConfig, CalibrationEntry } from "./calibration.js"

export { resolveWithGoodhart } from "./mechanism-interaction.js"
export type { MechanismConfig, ReputationScoringResult } from "./mechanism-interaction.js"

export { KillSwitch } from "./kill-switch.js"
