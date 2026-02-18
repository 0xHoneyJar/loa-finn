// src/credits/index.ts — Credit Module Barrel Exports (Sprint 2)

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
