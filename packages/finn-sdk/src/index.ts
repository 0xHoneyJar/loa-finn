// packages/finn-sdk/src/index.ts — Barrel Export (Sprint 7 T7.2, Sprint 3 T3.4)

export { FinnClient, FinnApiError, parseX402Challenge, formatReceiptHeaders } from "./client.js"

export type {
  FinnClientConfig,
  ChatRequest,
  ChatResponse,
  X402Challenge,
  X402Receipt,
  CreateKeyRequest,
  CreateKeyResponse,
  RevokeKeyResponse,
  KeyBalanceResponse,
  NonceResponse,
  VerifyRequest,
  VerifyResponse,
  ApiError,
  PaymentCallback,
  // Sprint 3 T3.4 additions
  X402InvokeRequest,
  X402InvokeResponse,
  X402Quote,
  X402QuoteResponse,
  NFTInfo,
  WalletNftsResponse,
  ToggleFlagRequest,
  ToggleFlagResponse,
  GetFlagsResponse,
  AllowlistRequest,
} from "./types.js"
