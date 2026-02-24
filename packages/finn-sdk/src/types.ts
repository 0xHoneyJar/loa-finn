// packages/finn-sdk/src/types.ts — Finn SDK Type Definitions (Sprint 7 T7.2)

// ---------------------------------------------------------------------------
// Agent Chat
// ---------------------------------------------------------------------------

export interface ChatRequest {
  token_id: string
  message: string
  session_id?: string
}

export interface ChatResponse {
  response: string
  personality: {
    archetype: "freetekno" | "milady" | "chicago_detroit" | "acidhouse"
    display_name: string
  }
  billing?: {
    method: "free" | "x402" | "api_key"
    amount_micro?: string
    request_id: string
  }
}

// ---------------------------------------------------------------------------
// x402 Payment
// ---------------------------------------------------------------------------

export interface X402Challenge {
  error: string
  code: string
  challenge: {
    nonce: string
    amount: string
    recipient: string
    chain_id: number
    expires_at: string
    hmac: string
  }
}

export interface X402Receipt {
  tx_hash: string
  nonce: string
}

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------

export interface CreateKeyRequest {
  label?: string
}

export interface CreateKeyResponse {
  key_id: string
  plaintext_key: string
  message: string
}

export interface RevokeKeyResponse {
  key_id: string
  revoked: boolean
}

export interface KeyBalanceResponse {
  key_id: string
  balance_micro: number
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface NonceResponse {
  nonce: string
}

export interface VerifyRequest {
  message: string
  signature: string
}

export interface VerifyResponse {
  token: string
  expires_in: number
  wallet_address: string
}

// ---------------------------------------------------------------------------
// x402 Invoke (Sprint 3 T3.4)
// ---------------------------------------------------------------------------

export interface X402InvokeRequest {
  model: string
  max_tokens?: number
  prompt: string
}

export interface X402InvokeResponse {
  result: string
  payment_id: string
  quote_id: string
}

export interface X402Quote {
  quote_id: string
  model: string
  max_tokens: number
  max_cost: string
  payment_address: string
  chain_id: number
  token_address: string
  valid_until: string
}

export interface X402QuoteResponse {
  error: string
  code: "PAYMENT_REQUIRED"
  quote: X402Quote
}

// ---------------------------------------------------------------------------
// Identity (Sprint 3 T3.4)
// ---------------------------------------------------------------------------

export interface NFTInfo {
  collection: string
  tokenId: string
  title: string
}

export interface WalletNftsResponse {
  nfts: NFTInfo[]
  total: number
}

// ---------------------------------------------------------------------------
// Admin (Sprint 3 T3.4)
// ---------------------------------------------------------------------------

export interface ToggleFlagRequest {
  flag: string
  enabled: boolean
}

export interface ToggleFlagResponse {
  flag: string
  enabled: boolean
}

export interface GetFlagsResponse {
  flags: Record<string, boolean>
}

export interface AllowlistRequest {
  action: "add" | "remove"
  addresses: string[]
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string
  code?: string
}

// ---------------------------------------------------------------------------
// Client Config
// ---------------------------------------------------------------------------

export interface FinnClientConfig {
  /** Base URL of the Finn API (e.g., "https://finn.honeyjar.xyz") */
  baseUrl: string
  /** API key (dk_ prefix) for authenticated requests */
  apiKey?: string
  /** SIWE session JWT for key management */
  sessionToken?: string
  /** Custom fetch implementation (for testing or Node.js polyfills) */
  fetch?: typeof globalThis.fetch
}

// ---------------------------------------------------------------------------
// Payment Callback
// ---------------------------------------------------------------------------

/**
 * Callback invoked when x402 payment is required.
 * Receives the challenge, must return the receipt (tx_hash + nonce).
 * Return null to abort the payment flow.
 */
export type PaymentCallback = (challenge: X402Challenge["challenge"]) => Promise<X402Receipt | null>
