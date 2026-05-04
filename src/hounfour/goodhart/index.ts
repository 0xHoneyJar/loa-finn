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

export { ReputationAdapter } from "./reputation-adapter.js"
export type { ReputationAdapterConfig } from "./reputation-adapter.js"

export { createDixieTransport } from "./transport-factory.js"

export { createReadOnlyRedisClient } from "./read-only-redis.js"

export { resolveWithGoodhart as resolveWithGoodhartTyped } from "./resolve.js"
export type { GoodhartOptions, GoodhartResult, ScoredPool } from "./resolve.js"

export { DixieStubTransport, DixieHttpTransport, DixieDirectTransport } from "./dixie-transport.js"
export type { DixieTransport, DixieHttpConfig, DixieReputationStore } from "./dixie-transport.js"

export { ReputationResponseSchema, normalizeResponse, wrapBareNumber } from "./reputation-response.js"
export type { ReputationResponse } from "./reputation-response.js"

export { scoreObservation, computeEventHash, normalizeToEvent, feedQualitySignal } from "./quality-signal.js"
export type { QualityObservation, QualitySignalConfig, ReputationEvent } from "./quality-signal.js"
