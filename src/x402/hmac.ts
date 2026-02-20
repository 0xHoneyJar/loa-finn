// src/x402/hmac.ts — x402 HMAC Challenge Signing & Verification (Sprint 2 T2.1, T2.2)
//
// HMAC-SHA256 signed challenges for x402 payment flow.
// Challenge fields are canonicalized (alphabetical, pipe-delimited) before signing.
// Verification uses constant-time comparison to prevent timing attacks.

import { createHmac, createHash, timingSafeEqual, randomUUID } from "node:crypto"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface X402Challenge {
  amount: string          // MicroUSDC (6 decimals)
  recipient: string       // X402_WALLET_ADDRESS
  chain_id: number        // 8453
  token: string           // USDC contract address
  nonce: string           // uuid-v4
  expiry: number          // Unix timestamp (5 min from now)
  request_path: string    // e.g., "/api/v1/agent/chat"
  request_method: string  // e.g., "POST"
  request_binding: string // SHA-256 of stable request fields
  hmac: string            // HMAC-SHA256 signature over ALL above fields
}

// ---------------------------------------------------------------------------
// Request Binding (v1 — Flatline SKP-004)
// ---------------------------------------------------------------------------

/**
 * Compute request binding v1: SHA-256(token_id | model | max_tokens)
 * Binds the challenge to specific request parameters so a valid payment
 * cannot be replayed against different inference parameters.
 *
 * Fields are pipe-delimited, all lowercased, deterministic.
 * If a field is absent, use empty string.
 */
export function computeRequestBinding(params: {
  token_id: string
  model: string
  max_tokens: number
}): string {
  const data = [
    params.token_id.toLowerCase(),
    params.model.toLowerCase(),
    params.max_tokens.toString(),
  ].join("|")
  return createHash("sha256").update(data).digest("hex")
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/**
 * Canonical serialization for HMAC signing.
 * Deterministic: fields in alphabetical order, pipe-delimited.
 * This ensures the same inputs always produce the same HMAC.
 */
function canonicalize(fields: Omit<X402Challenge, "hmac">): string {
  return [
    fields.amount,
    fields.chain_id.toString(),
    fields.expiry.toString(),
    fields.nonce,
    fields.recipient,
    fields.request_binding,
    fields.request_method,
    fields.request_path,
    fields.token,
  ].join("|")
}

// ---------------------------------------------------------------------------
// Signing (T2.1)
// ---------------------------------------------------------------------------

/**
 * Sign challenge fields with HMAC-SHA256.
 * Returns complete X402Challenge with hmac field populated.
 */
export function signChallenge(
  fields: Omit<X402Challenge, "hmac">,
  secret: string,
): X402Challenge {
  const canonical = canonicalize(fields)
  const hmac = createHmac("sha256", secret).update(canonical).digest("hex")
  return { ...fields, hmac }
}

// ---------------------------------------------------------------------------
// Verification (T2.2)
// ---------------------------------------------------------------------------

/**
 * Verify HMAC integrity of a challenge.
 * Returns false (never throws) on any invalid input.
 *
 * Security properties:
 * - Validates HMAC is exactly 64 hex chars before comparison
 * - Decodes as hex (not UTF-8) for proper buffer comparison
 * - Uses timingSafeEqual for constant-time comparison
 * - Length guard before timingSafeEqual (requirement: buffers must be same length)
 */
export function verifyChallenge(
  challenge: X402Challenge,
  secret: string,
): boolean {
  const { hmac: received, ...fields } = challenge

  // Validate HMAC format: must be exactly 64 lowercase hex chars
  if (!/^[0-9a-f]{64}$/.test(received)) return false

  const expected = createHmac("sha256", secret)
    .update(canonicalize(fields))
    .digest("hex")

  // Decode as hex (not UTF-8) for proper constant-time comparison
  const receivedBuf = Buffer.from(received, "hex")
  const expectedBuf = Buffer.from(expected, "hex")

  // Both are SHA-256 output (32 bytes), but guard anyway
  if (receivedBuf.length !== expectedBuf.length) return false

  return timingSafeEqual(receivedBuf, expectedBuf)
}

// ---------------------------------------------------------------------------
// Challenge Factory
// ---------------------------------------------------------------------------

export interface ChallengeParams {
  amount: string
  recipient: string
  chain_id: number
  token: string
  request_path: string
  request_method: string
  request_binding: string
  ttlSeconds?: number
}

/**
 * Create a signed X402Challenge with fresh nonce and expiry.
 */
export function createChallenge(params: ChallengeParams, secret: string): X402Challenge {
  const now = Math.floor(Date.now() / 1000)
  const ttl = params.ttlSeconds ?? 300 // 5 minutes default

  const fields: Omit<X402Challenge, "hmac"> = {
    amount: params.amount,
    recipient: params.recipient,
    chain_id: params.chain_id,
    token: params.token,
    nonce: randomUUID(),
    expiry: now + ttl,
    request_path: params.request_path,
    request_method: params.request_method,
    request_binding: params.request_binding,
  }

  return signChallenge(fields, secret)
}
