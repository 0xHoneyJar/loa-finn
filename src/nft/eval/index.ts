// src/nft/eval/index.ts — Evaluation Harness Barrel Exports (Sprint 12 + 13)

// Harness core (Sprint 12 Task 12.1)
export {
  EvalRunner,
  STANDARD_EVAL_PROMPTS,
  type EvalConfig,
  type EvalPrompt,
  type EvalPersonality,
  type EvalResponse,
  type EvalRunResult,
} from "./harness.js"

// Providers (Sprint 12 Task 12.1a)
export {
  type EvalLLMProvider,
  type EmbeddingProvider,
  type JudgeProvider,
  FakeEvalLLMProvider,
  FakeEmbeddingProvider,
  FakeJudgeProvider,
} from "./providers.js"

// Distinctiveness (Sprint 12 Task 12.2)
export {
  cosineSimilarity,
  scoreDistinctiveness,
  type DistinctivenessResult,
} from "./distinctiveness.js"

// Fidelity (Sprint 12 Task 12.3)
export {
  scoreFidelity,
  stripArchetypeLabels,
  type FidelityResult,
} from "./fidelity.js"

// Anti-Narration Batch (Sprint 12 Task 12.4)
export {
  checkAntiNarrationBatch,
  type ANBatchResult,
} from "./anti-narration-eval.js"

// Temporal Consistency (Sprint 12 Task 12.5)
export {
  scoreTemporalConsistency,
  type TemporalResult,
} from "./temporal-eval.js"

// dAMP Behavioral Distinctiveness (Sprint 13 Task 13.1)
export {
  scoreDAMPDistinctiveness,
  welchTTest,
  extractBehavioralFeatures,
  DAMP_DIMENSION_PREFIXES,
  type DAMPEvalConfig,
  type DAMPDimensionResult,
  type DAMPEvalResult,
  type DAMPDimensionPrefix,
} from "./damp-eval.js"

// Aggregate Scorecard (Sprint 13 Task 13.2)
export {
  buildScorecards,
  type EvalScorecard,
  type AggregateScorecard,
} from "./scorecard.js"

// Personality Drift Analysis (Sprint 16 Task 16.4)
export {
  computeDrift,
  getTopChangedDials,
  analyzeDrift,
  type DialChange,
  type DriftResult,
  type VersionChainDrift,
} from "./drift.js"
