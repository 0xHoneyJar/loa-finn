// src/hounfour/protocol-types.ts — Centralized Protocol Type Re-exports (Sprint 2, Tasks 2.3 + 2.4)
//
// Single import point for protocol types from @0xhoneyjar/loa-hounfour.
// Consumers import from here instead of reaching into subpackages directly.

// Economy — MicroUSDC branded type (replaces local brand)
export type { MicroUSDC } from "@0xhoneyjar/loa-hounfour/economy"
export {
  microUSDC,
  readMicroUSDC,
  serializeMicroUSDC as protocolSerializeMicroUSDC,
  deserializeMicroUSDC,
  microUSDToUSDC,
  microUSDCToUSD,
} from "@0xhoneyjar/loa-hounfour/economy"

// Economy — Branded arithmetic types (already imported in wire-boundary via main export)
export type {
  BrandedMicroUSD,
  BasisPoints,
  AccountId,
} from "@0xhoneyjar/loa-hounfour/economy"

// Economy — JWT Schemas (Task 2.4)
export {
  JwtClaimsSchema,
  S2SJwtClaimsSchema,
  JTI_POLICY as PROTOCOL_JTI_POLICY,
} from "@0xhoneyjar/loa-hounfour/economy"
export type {
  JwtClaims as ProtocolJwtClaims,
  S2SJwtClaims as ProtocolS2SJwtClaims,
} from "@0xhoneyjar/loa-hounfour/economy"

// Economy — Billing Schemas (Task 2.4)
export { BillingEntrySchema as ProtocolBillingEntrySchema } from "@0xhoneyjar/loa-hounfour/economy"
export type { BillingEntry as ProtocolBillingEntry } from "@0xhoneyjar/loa-hounfour/economy"

// Economy — Economic Boundary Schemas (Task 2.4)
export {
  EconomicBoundarySchema,
  QualificationCriteriaSchema,
  DenialCodeSchema,
  EvaluationGapSchema,
} from "@0xhoneyjar/loa-hounfour/economy"
export type {
  EconomicBoundary,
  QualificationCriteria,
  DenialCode,
  EvaluationGap,
} from "@0xhoneyjar/loa-hounfour/economy"

// Economy — Model Economic Profile (Task 2.4)
export { ModelEconomicProfileSchema } from "@0xhoneyjar/loa-hounfour/economy"
export type { ModelEconomicProfile } from "@0xhoneyjar/loa-hounfour/economy"

// Economy — JWT Boundary Spec (Task 2.4 — replay_window_seconds reference)
export { JwtBoundarySpecSchema } from "@0xhoneyjar/loa-hounfour/economy"
export type { JwtBoundarySpec } from "@0xhoneyjar/loa-hounfour/economy"

// Constraints — Constraint Origin (Task 2.4)
export type { ConstraintOrigin } from "@0xhoneyjar/loa-hounfour/constraints"

// Reputation — State vocabulary and type guard (Task 2.4)
export {
  REPUTATION_STATES,
  REPUTATION_STATE_ORDER,
  isKnownReputationState,
} from "@0xhoneyjar/loa-hounfour"
export type { ReputationStateName } from "@0xhoneyjar/loa-hounfour"

// Economy — Pricing Utilities (Task 2.5)
export {
  computeCostMicro as protocolComputeCostMicro,
  computeCostMicroSafe as protocolComputeCostMicroSafe,
  verifyPricingConservation,
} from "@0xhoneyjar/loa-hounfour/economy"
export type {
  PricingInput as ProtocolPricingInput,
  UsageInput as ProtocolUsageInput,
  ConservationResult,
} from "@0xhoneyjar/loa-hounfour/economy"

// Economy — Billing Utilities (Task 2.5)
export {
  validateBillingEntry as protocolValidateBillingEntry,
  validateBillingRecipients as protocolValidateBillingRecipients,
  validateCreditNote as protocolValidateCreditNote,
  allocateRecipients as protocolAllocateRecipients,
} from "@0xhoneyjar/loa-hounfour/economy"

// Economy — NFT ID Utilities (Task 2.5)
export {
  isValidNftId,
  parseNftId,
  formatNftId,
  checksumAddress,
} from "@0xhoneyjar/loa-hounfour/economy"
export type { NftId, ParsedNftId } from "@0xhoneyjar/loa-hounfour/economy"

// Economy — Vocabulary Constants (Task 2.5)
export {
  TRANSFER_CHOREOGRAPHY,
  TRANSFER_INVARIANTS,
} from "@0xhoneyjar/loa-hounfour/economy"
export type { TransferChoreography, TransferInvariant } from "@0xhoneyjar/loa-hounfour/economy"

export {
  ECONOMIC_CHOREOGRAPHY,
} from "@0xhoneyjar/loa-hounfour/economy"
export type { EconomicChoreography } from "@0xhoneyjar/loa-hounfour/economy"

// Economy — Economic Boundary Evaluation (Task 3.1)
export {
  evaluateEconomicBoundary,
  evaluateFromBoundary,
} from "@0xhoneyjar/loa-hounfour"
export {
  TrustLayerSnapshotSchema,
  CapitalLayerSnapshotSchema,
  AccessDecisionSchema,
  TrustEvaluationSchema,
  CapitalEvaluationSchema,
  EconomicBoundaryEvaluationResultSchema,
} from "@0xhoneyjar/loa-hounfour/economy"
export type {
  TrustLayerSnapshot,
  CapitalLayerSnapshot,
  AccessDecision,
  TrustEvaluation,
  CapitalEvaluation,
  EconomicBoundaryEvaluationResult,
} from "@0xhoneyjar/loa-hounfour/economy"

// Access Policy Evaluation (Task 2.6)
export {
  evaluateAccessPolicy,
} from "@0xhoneyjar/loa-hounfour"
export type {
  AccessPolicyContext,
  AccessPolicyResult,
} from "@0xhoneyjar/loa-hounfour"

// --- v7.11.0 Protocol Convergence (Cycle 034) ---

// Task-Dimensional Reputation types (FR-3)
export type { TaskTypeCohort } from "@0xhoneyjar/loa-hounfour"
export { TaskTypeCohortSchema } from "@0xhoneyjar/loa-hounfour"

// Scoring path logging (FR-3, Goodhart protection)
export type { ScoringPath, ScoringPathLog } from "@0xhoneyjar/loa-hounfour"
export { ScoringPathSchema, ScoringPathLogSchema } from "@0xhoneyjar/loa-hounfour"

// ── v8.2.0 additions ──────────────────────────────────────────────────

// Governance — ReputationEvent discriminated union (v8.2.0)
export {
  ReputationEventSchema,
  ModelPerformanceEventSchema,
} from "@0xhoneyjar/loa-hounfour/governance"
export type {
  ReputationEvent,
  ModelPerformanceEvent,
} from "@0xhoneyjar/loa-hounfour/governance"

// Governance — QualityObservation (v8.2.0)
export {
  QualityObservationSchema,
} from "@0xhoneyjar/loa-hounfour/governance"
export type {
  QualityObservation,
} from "@0xhoneyjar/loa-hounfour/governance"

// Governance — TaskType vocabulary (v8.2.0)
// Note: supersedes v7.11 GovernanceTaskType alias — v8.2.0 exports from /governance subpackage
export {
  TaskTypeSchema,
  TASK_TYPES,
} from "@0xhoneyjar/loa-hounfour/governance"
export type {
  TaskType,
} from "@0xhoneyjar/loa-hounfour/governance"

// Commons — governance infrastructure (v8.0.0)
export {
  GovernanceMutationSchema,
  evaluateGovernanceMutation,
  InvariantSchema,
  InvariantViolationSchema,
  ProtocolCapabilitySchema,
  ProtocolSurfaceSchema,
  QuarantineRecordSchema,
  QuarantineStatusSchema,
} from "@0xhoneyjar/loa-hounfour/commons"
export type {
  GovernanceMutation,
  Invariant,
  InvariantViolation,
  ProtocolCapability,
  ProtocolSurface,
  QuarantineRecord,
  QuarantineStatus,
} from "@0xhoneyjar/loa-hounfour/commons"

// Commons — conservation law factories (v8.0.0, Sprint 5 T-5.5)
export {
  ConservationLawSchema,
  buildSumInvariant,
  buildNonNegativeInvariant,
  buildBoundedInvariant,
  createBalanceConservation,
} from "@0xhoneyjar/loa-hounfour/commons"
export type {
  ConservationLaw,
} from "@0xhoneyjar/loa-hounfour/commons"

// Commons — audit trail hash chain (v8.0.0, Sprint 5 T-5.5)
export {
  AuditEntrySchema,
  AuditTrailSchema,
  AUDIT_TRAIL_GENESIS_HASH,
  buildDomainTag,
  computeAuditEntryHash,
  verifyAuditTrailIntegrity,
} from "@0xhoneyjar/loa-hounfour/commons"
export type {
  AuditEntry,
  AuditTrail,
  AuditEntryHashInput,
  AuditTrailVerificationResult,
} from "@0xhoneyjar/loa-hounfour/commons"

// ── v8.3.0 Pre-Launch Hardening (Cycle 038) ──────────────────────────────

// Chain-bound hash — links audit entries to predecessors (SDD §5.1)
export {
  computeChainBoundHash,
  validateDomainTag,
  ChainBoundHashError,
} from "@0xhoneyjar/loa-hounfour/commons"
// Note: AuditEntryHashInput already exported above — serves as ChainBoundHashInput

// Audit timestamp validation — strict ISO 8601 boundary checks (SDD §5.2)
export { validateAuditTimestamp } from "@0xhoneyjar/loa-hounfour/commons"
export type { AuditTimestampResult } from "@0xhoneyjar/loa-hounfour/commons"

// Advisory lock key — FNV-1a 32-bit for pg_advisory_xact_lock (SDD §5.4)
export { computeAdvisoryLockKey } from "@0xhoneyjar/loa-hounfour/commons"

// Feedback dampening — EMA with cold-start Bayesian prior (SDD §5.3)
export {
  computeDampenedScore,
  FeedbackDampeningConfigSchema,
  FEEDBACK_DAMPENING_ALPHA_MIN,
  FEEDBACK_DAMPENING_ALPHA_MAX,
  DAMPENING_RAMP_SAMPLES,
  DEFAULT_PSEUDO_COUNT,
} from "@0xhoneyjar/loa-hounfour/commons"
export type { FeedbackDampeningConfig } from "@0xhoneyjar/loa-hounfour/commons"

// GovernedResource runtime interface (SDD §4.8)
export type {
  GovernedResource,
  TransitionResult,
  InvariantResult,
  MutationContext,
} from "@0xhoneyjar/loa-hounfour/commons"
export { GovernedResourceBase } from "@0xhoneyjar/loa-hounfour/commons"

// X402 canonical schemas — protocol-level payment types (SDD §6.1)
// Note: finn has local wire types in src/x402/types.ts with different shapes;
// these canonical schemas are for protocol-level contract validation.
export {
  X402QuoteSchema,
  X402PaymentProofSchema,
  X402SettlementSchema,
  X402SettlementStatusSchema,
  X402ErrorCodeSchema,
} from "@0xhoneyjar/loa-hounfour/economy"
export type {
  X402Quote as CanonicalX402Quote,
  X402PaymentProof as CanonicalX402PaymentProof,
  X402Settlement as CanonicalX402Settlement,
  X402SettlementStatus as CanonicalX402SettlementStatus,
  X402ErrorCode as CanonicalX402ErrorCode,
} from "@0xhoneyjar/loa-hounfour/economy"

// Consumer contracts — drift detection for downstream consumers (SDD §4.4)
export {
  ConsumerContractSchema,
  ConsumerContractEntrypointSchema,
  validateConsumerContract,
  computeContractChecksum,
} from "@0xhoneyjar/loa-hounfour/integrity"
export type {
  ConsumerContract,
  ConsumerContractEntrypoint,
  ContractValidationResult,
} from "@0xhoneyjar/loa-hounfour/integrity"

// Tier-to-reputation mapping — bridges billing tiers to reputation states (SDD §6.2)
export { mapTierToReputationState } from "@0xhoneyjar/loa-hounfour/governance"

// Constraint conditionals — feature-flag-gated constraint evaluation (SDD §6.6)
export type { ConstraintCondition } from "@0xhoneyjar/loa-hounfour/constraints"
export { resolveConditionalExpression } from "@0xhoneyjar/loa-hounfour/constraints"
