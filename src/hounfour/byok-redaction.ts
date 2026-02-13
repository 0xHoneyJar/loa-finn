// src/hounfour/byok-redaction.ts — BYOK Deny-by-Default Redaction (SDD §4.7, Task C.3)
//
// Two-layer redaction strategy:
//   1. Deny-by-default: redact everything, allowlist specific fields
//   2. Pattern-based backup: scan for known API key patterns as secondary layer
//
// Provider error body scrubbing: replace full error body with safe stub.

// --- Types ---

/** Fields allowed through redaction (deny-by-default allowlist) */
const ALLOWED_RESPONSE_FIELDS = new Set([
  "status",
  "model",
  "usage",
  "prompt_tokens",
  "completion_tokens",
  "reasoning_tokens",
  "total_tokens",
  "finish_reason",
  "id",
  "object",
  "created",
  "system_fingerprint",
])

/** Provider error codes allowed to pass through */
const ALLOWED_ERROR_CODES = new Set([
  "rate_limit",
  "rate_limit_exceeded",
  "model_not_found",
  "context_length_exceeded",
  "invalid_request_error",
  "insufficient_quota",
])

/** Known API key patterns for backup redaction */
const KEY_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "openai", regex: /sk-[a-zA-Z0-9_-]{20,}/ },
  { name: "anthropic", regex: /anthropic-[a-zA-Z0-9_-]{20,}/ },
  { name: "bearer", regex: /Bearer\s+[a-zA-Z0-9._\-/+=]{20,}/ },
]

const REDACTED = "[REDACTED]"

// --- Shannon Entropy ---

/**
 * Calculate Shannon entropy of a string in bits per character.
 * High entropy (> 4.5) suggests a random/cryptographic string.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0

  const freq = new Map<string, number>()
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1)
  }

  let entropy = 0
  for (const count of freq.values()) {
    const p = count / s.length
    if (p > 0) entropy -= p * Math.log2(p)
  }

  return entropy
}

// --- Pattern-Based Redaction ---

/**
 * Scan a string for known API key patterns and high-entropy base64 strings.
 * Returns the string with all matches replaced by [REDACTED].
 */
export function redactKeyPatterns(input: string): string {
  let result = input

  // Layer 1: Known key patterns
  for (const { regex } of KEY_PATTERNS) {
    result = result.replace(new RegExp(regex.source, "g"), REDACTED)
  }

  // Layer 2: High-entropy base64 strings >= 16 chars (lowered from 21 to catch
  // truncated API key fragments in error messages — BB-063-002)
  result = result.replace(/[A-Za-z0-9+/=_-]{16,}/g, (match) => {
    if (shannonEntropy(match) > 4.5) {
      return REDACTED
    }
    return match
  })

  return result
}

/**
 * Check if a string contains any API key patterns.
 * Used for assertion testing (should return false in all BYOK log output).
 */
export function containsKeyPattern(input: string): boolean {
  for (const { regex } of KEY_PATTERNS) {
    if (regex.test(input)) return true
  }

  // Check for high-entropy base64 strings (threshold matches redactSecrets)
  const matches = input.match(/[A-Za-z0-9+/=_-]{16,}/g)
  if (matches) {
    for (const match of matches) {
      if (shannonEntropy(match) > 4.5) return true
    }
  }

  return false
}

// --- Deny-by-Default Response Redaction ---

/**
 * Redact a provider response body, keeping only allowed fields.
 * Deny-by-default: everything not in the allowlist is removed.
 */
export function redactResponseBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) {
    return { redacted: true }
  }

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (ALLOWED_RESPONSE_FIELDS.has(key)) {
      // Recursively sanitize nested objects (but only keep allowed fields)
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        result[key] = redactResponseBody(value)
      } else if (typeof value === "string") {
        result[key] = redactKeyPatterns(value)
      } else {
        result[key] = value
      }
    }
  }

  return result
}

// --- Provider Error Scrubbing ---

/** Scrubbed provider error (safe for logging and returning to client) */
export interface ScrubbedProviderError {
  provider_error: true
  status: number
  message: string
  error_code?: string
}

/**
 * Scrub a provider error response for safe logging/return.
 * Only passes through allow-listed error codes.
 */
export function scrubProviderError(status: number, body: unknown): ScrubbedProviderError {
  const result: ScrubbedProviderError = {
    provider_error: true,
    status,
    message: "<redacted>",
  }

  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>

    // Extract error code if it's an allowed one
    const errorCode = (b.error as Record<string, unknown>)?.code as string
      ?? (b.error as Record<string, unknown>)?.type as string
      ?? b.code as string
      ?? b.type as string

    if (errorCode && ALLOWED_ERROR_CODES.has(errorCode)) {
      result.error_code = errorCode
      // For allowed error codes, provide a generic message
      result.message = errorCodeToMessage(errorCode)
    }
  }

  return result
}

function errorCodeToMessage(code: string): string {
  switch (code) {
    case "rate_limit":
    case "rate_limit_exceeded":
      return "Rate limit exceeded"
    case "model_not_found":
      return "Model not found"
    case "context_length_exceeded":
      return "Context length exceeded"
    case "invalid_request_error":
      return "Invalid request"
    case "insufficient_quota":
      return "Insufficient quota"
    default:
      return "<redacted>"
  }
}

// --- BYOK Audit Logger ---

/** Audit log entry fields (NO request/response bodies) */
export interface BYOKAuditEntry {
  timestamp: string
  request_id: string
  tenant_id: string
  provider: string
  endpoint: string
  status: number
  latency_ms: number
}

/**
 * Create a BYOK audit log entry. Guaranteed to contain no key material.
 */
export function createAuditEntry(
  requestId: string,
  tenantId: string,
  provider: string,
  endpoint: string,
  status: number,
  latencyMs: number,
): BYOKAuditEntry {
  return {
    timestamp: new Date().toISOString(),
    request_id: requestId,
    tenant_id: tenantId,
    provider,
    endpoint: endpoint.replace(/\?.*$/, ""), // Strip query params
    status,
    latency_ms: latencyMs,
  }
}
