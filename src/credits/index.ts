// src/credits/index.ts — Credit Module Barrel Exports (Sprint 2 + Sprint 3)

// Types
export {
  CREDIT_PACKS,
  type PackSize,
  isValidPackSize,
  USDC_CONTRACT_ADDRESS,
  MIN_CONFIRMATIONS,
  getTreasuryAddress,
  CreditPurchaseError,
  type CreditPurchaseErrorCode,
  type CreditPurchaseRequest,
  type CreditPurchaseResult,
  type PaymentProof,
  type VerificationBinding,
} from "./types.js"

// Purchase
export {
  CreditPurchaseService,
  creditPurchaseRoutes,
  createPurchaseClients,
  type CreditPurchaseDeps,
} from "./purchase.js"

// Reorg Detection
export {
  ReorgDetector,
  type ReorgDetectorDeps,
  type ReorgCheckResult,
  type StoredMint,
} from "./reorg-detector.js"

// Credit Deduction (Sprint 3 Task 3.1)
export {
  CreditDeductionService,
  InsufficientCreditsError,
  type CreditDeductionDeps,
  type ReserveCreditResult,
  type CommitCreditResult,
} from "./conversion.js"

// BYOK Entitlement (Sprint 3 Task 3.2)
export {
  EntitlementService,
  EntitlementError,
  BYOK_DAILY_RATE_LIMIT,
  GRACE_PERIOD_MS,
  DEFAULT_SUBSCRIPTION_DURATION_MS,
  type EntitlementState,
  type EntitlementRecord,
  type EntitlementCheckResult,
  type DailyLimitResult,
  type EntitlementDeps,
} from "./entitlement.js"
