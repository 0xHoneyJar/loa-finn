// src/hounfour/hmac.ts — Shared HMAC signing for sidecar + ChevalInvoker (SDD §4.1, T-1.1)

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

// --- Types ---

export interface HmacConfig {
  secret: string
  secretPrev?: string             // For zero-downtime rotation
  skewSeconds?: number            // Clock skew tolerance (default: 30)
}

export interface HmacHeaders {
  "x-cheval-signature": string
  "x-cheval-nonce": string
  "x-cheval-issued-at": string
  "x-cheval-trace-id": string
}

// --- Canonical String ---

/**
 * Build the HMAC canonical string for signing.
 *
 * Format (newline-delimited, endpoint-bound):
 *   method + "\n" + path + "\n" + SHA256(body) + "\n" + issuedAt + "\n" + nonce + "\n" + traceId
 *
 * This binds the signature to a specific endpoint, preventing replay
 * of a signed /invoke request against /invoke/stream (or vice versa).
 */
export function buildCanonical(
  method: string,
  path: string,
  body: string,
  issuedAt: string,
  nonce: string,
  traceId: string,
): string {
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex")
  return `${method}\n${path}\n${bodyHash}\n${issuedAt}\n${nonce}\n${traceId}`
}

/**
 * Compute HMAC-SHA256 signature over canonical string.
 */
export function computeSignature(canonical: string, secret: string): string {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex")
}

// --- Signing ---

/**
 * Sign a request for the Cheval sidecar.
 *
 * Returns headers to attach to the HTTP request.
 * The sidecar's HMACVerificationMiddleware verifies these.
 */
export function signRequest(
  method: string,
  path: string,
  body: string,
  traceId: string,
  secret: string,
): HmacHeaders {
  const nonce = generateNonce()
  const issuedAt = new Date().toISOString()
  const canonical = buildCanonical(method, path, body, issuedAt, nonce, traceId)
  const signature = computeSignature(canonical, secret)

  return {
    "x-cheval-signature": signature,
    "x-cheval-nonce": nonce,
    "x-cheval-issued-at": issuedAt,
    "x-cheval-trace-id": traceId,
  }
}

// --- Verification ---

/**
 * Verify an HMAC signature with clock skew checking.
 *
 * Supports dual-secret verification for zero-downtime rotation:
 * tries current secret first, then previous secret if provided.
 *
 * Returns true if the signature is valid and within skew window.
 */
export function verifySignature(
  method: string,
  path: string,
  body: string,
  signature: string,
  nonce: string,
  issuedAt: string,
  traceId: string,
  config: HmacConfig,
): boolean {
  const skew = (config.skewSeconds ?? 30) * 1000

  // Clock skew check
  const issuedTime = new Date(issuedAt).getTime()
  if (Number.isNaN(issuedTime)) return false
  const drift = Math.abs(Date.now() - issuedTime)
  if (drift > skew) return false

  const canonical = buildCanonical(method, path, body, issuedAt, nonce, traceId)

  // Try current secret
  const expected = computeSignature(canonical, config.secret)
  if (timingSafeCompare(signature, expected)) return true

  // Try previous secret for rotation
  if (config.secretPrev) {
    const expectedPrev = computeSignature(canonical, config.secretPrev)
    if (timingSafeCompare(signature, expectedPrev)) return true
  }

  return false
}

// --- Utilities ---

/** Generate a random 32-character hex nonce */
export function generateNonce(): string {
  return randomBytes(16).toString("hex")
}

/**
 * Timing-safe string comparison.
 * Converts to Buffer for constant-time comparison, avoiding timing side-channels.
 */
function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  return timingSafeEqual(bufA, bufB)
}

// --- Legacy Compatibility ---

/**
 * Legacy signing for subprocess mode (Phase 0-2 format).
 *
 * Uses JSON canonical string: {"body_hash":..., "issued_at":..., "nonce":..., "trace_id":...}
 * Kept for backward compatibility with the subprocess cheval.py path.
 */
export function signRequestLegacy(
  body: string,
  secret: string,
  nonce: string,
  traceId: string,
  issuedAt: string,
): string {
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex")
  const canonical = JSON.stringify({
    body_hash: bodyHash,
    issued_at: issuedAt,
    nonce: nonce,
    trace_id: traceId,
  })
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex")
}
