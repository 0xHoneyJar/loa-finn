// src/boot/consumer-contract-check.ts — Consumer Contract Validation (T-3.5, SDD §4.4)
//
// Warn-only startup validation: checks that finn's expected hounfour symbols
// are present in the actual protocol-types barrel. Logs warning on drift,
// never throws or exits.

import * as ProtocolTypes from "../hounfour/protocol-types.js"
import {
  validateConsumerContract,
  computeContractChecksum,
} from "../hounfour/protocol-types.js"
import type { ConsumerContract } from "../hounfour/protocol-types.js"

// ---------------------------------------------------------------------------
// FINN_CONTRACT — expected hounfour symbols per entrypoint (inline constant)
// ---------------------------------------------------------------------------

/**
 * Finn's consumer contract declaring the minimum set of symbols it requires
 * from @0xhoneyjar/loa-hounfour via the protocol-types barrel.
 *
 * The single "protocol-types" entrypoint reflects finn's barrel re-export
 * pattern — all hounfour symbols are consumed through src/hounfour/protocol-types.ts.
 */
/**
 * Symbols re-exported from protocol-types barrel that finn does NOT consume at runtime.
 * These are re-exported for future use or are type-only at the JS level.
 * Adding a new barrel export here prevents CI noise from the contract tests.
 * (T-4.1 contract scope policy — GPT-review IMP-001)
 */
export const NON_CONTRACT_EXPORTS = new Set([
  // Forward-looking governance types (re-exported but not consumed at runtime)
  "mapTierToReputationState",
  "resolveConditionalExpression",
  // Schemas re-exported but not directly imported by finn runtime code
  "ConsumerContractSchema",
  "ConsumerContractEntrypointSchema",
  "X402QuoteSchema",
  "X402PaymentProofSchema",
  "X402SettlementSchema",
  "X402SettlementStatusSchema",
  "X402ErrorCodeSchema",
  "EconomicBoundarySchema",
  "QualificationCriteriaSchema",
  "DenialCodeSchema",
  "EvaluationGapSchema",
  "ModelEconomicProfileSchema",
  "JwtBoundarySpecSchema",
  "ProtocolBillingEntrySchema",
  "JwtClaimsSchema",
  "S2SJwtClaimsSchema",
  "ReputationEventSchema",
  "ModelPerformanceEventSchema",
  "QualityObservationSchema",
  "TaskTypeSchema",
  "TASK_TYPES",
  "InvariantViolationSchema",
  "ProtocolCapabilitySchema",
  "ProtocolSurfaceSchema",
  "QuarantineStatusSchema",
  "AuditTrailSchema",
  "TrustLayerSnapshotSchema",
  "CapitalLayerSnapshotSchema",
  "AccessDecisionSchema",
  "TrustEvaluationSchema",
  "CapitalEvaluationSchema",
  "EconomicBoundaryEvaluationResultSchema",
  "TaskTypeCohortSchema",
  "ScoringPathSchema",
  "ScoringPathLogSchema",
  // Utility functions re-exported but not imported by finn runtime code
  "deserializeMicroUSDC",
  "microUSDToUSDC",
  "microUSDCToUSD",
  "formatNftId",
  "checksumAddress",
  "protocolComputeCostMicroSafe",
  "protocolValidateBillingEntry",
  "protocolValidateBillingRecipients",
  "protocolValidateCreditNote",
  "protocolAllocateRecipients",
  "evaluateFromBoundary",
  "evaluateGovernanceMutation",
  "buildSumInvariant",
  // Constants re-exported but not directly consumed
  "TRANSFER_CHOREOGRAPHY",
  "TRANSFER_INVARIANTS",
  "ECONOMIC_CHOREOGRAPHY",
  "REPUTATION_STATE_ORDER",
  "FEEDBACK_DAMPENING_ALPHA_MIN",
  "FEEDBACK_DAMPENING_ALPHA_MAX",
  "DAMPENING_RAMP_SAMPLES",
  "DEFAULT_PSEUDO_COUNT",
  "ChainBoundHashError",
])

export const FINN_CONTRACT: ConsumerContract = {
  consumer: "loa-finn",
  provider: "@0xhoneyjar/loa-hounfour",
  provider_version_range: ">=8.3.0",
  entrypoints: {
    "protocol-types": {
      symbols: [
        // Economy — core
        "microUSDC",
        "readMicroUSDC",
        "protocolSerializeMicroUSDC",
        "isValidNftId",
        "parseNftId",
        // Economy — pricing
        "protocolComputeCostMicro",
        "verifyPricingConservation",
        // Economy — boundary evaluation
        "evaluateEconomicBoundary",
        // Economy — JWT
        "PROTOCOL_JTI_POLICY",
        // Access policy
        "evaluateAccessPolicy",
        // Commons — audit trail
        "computeAuditEntryHash",
        "computeChainBoundHash",
        "validateDomainTag",
        "buildDomainTag",
        "AUDIT_TRAIL_GENESIS_HASH",
        "verifyAuditTrailIntegrity",
        "AuditEntrySchema",
        "QuarantineRecordSchema",
        // Commons — audit timestamp
        "validateAuditTimestamp",
        // Commons — advisory lock
        "computeAdvisoryLockKey",
        // Commons — dampening
        "computeDampenedScore",
        "FeedbackDampeningConfigSchema",
        // Commons — governance
        "GovernedResourceBase",
        "GovernanceMutationSchema",
        "InvariantSchema",
        // Commons — conservation laws
        "ConservationLawSchema",
        "buildNonNegativeInvariant",
        "buildBoundedInvariant",
        "createBalanceConservation",
        // Integrity — consumer contracts
        "validateConsumerContract",
        "computeContractChecksum",
        // Governance — reputation
        "REPUTATION_STATES",
        "isKnownReputationState",
      ],
    },
  },
  generated_at: "2026-02-28T00:00:00Z",
}

// ---------------------------------------------------------------------------
// FINN_EXPORT_MAP — derived from actual barrel exports (no dynamic import)
// ---------------------------------------------------------------------------

/**
 * Build export map from Object.keys of the protocol-types barrel.
 * Maps the single "protocol-types" entrypoint to its actual symbol names.
 */
export function buildExportMap(): Record<string, string[]> {
  return {
    "protocol-types": Object.keys(ProtocolTypes),
  }
}

// ---------------------------------------------------------------------------
// Startup validation — warn-only, never throws
// ---------------------------------------------------------------------------

/**
 * Run consumer contract validation at startup (T-3.5).
 * Logs warning on symbol drift, never throws or exits.
 */
export function runConsumerContractCheck(): void {
  try {
    const exportMap = buildExportMap()
    const result = validateConsumerContract(FINN_CONTRACT, exportMap)

    if (!result.valid) {
      const missing = result.missing_symbols
        .map((s) => `${s.entrypoint}:${s.symbol}`)
        .join(", ")
      console.warn(
        `[consumer-contract] Drift detected — missing symbols: ${missing}`,
      )
    }

    const checksum = computeContractChecksum(FINN_CONTRACT)
    if (FINN_CONTRACT.checksum && FINN_CONTRACT.checksum !== checksum) {
      console.warn(
        `[consumer-contract] Contract checksum mismatch: expected=${FINN_CONTRACT.checksum} actual=${checksum}`,
      )
    }
  } catch (err) {
    console.warn("[consumer-contract] Validation failed:", err)
  }
}
