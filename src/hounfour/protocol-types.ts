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
