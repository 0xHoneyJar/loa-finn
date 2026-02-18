// src/hounfour/wire-boundary.ts — Centralized Branded Type Parse/Serialize Layer (SDD §4.1)
//
// This module is the SOLE CONSTRUCTOR for branded type values in the application.
// Enforcement: type-level (brand not exported), lint-level (ESLint bans `as MicroUSD`),
// runtime-level (assertMicroUSDFormat at persistence boundaries).
//
// Design: Stripe pattern — module-private brand helper, parse at ingress, serialize at egress.

import type { BrandedMicroUSD as MicroUSD, BasisPoints, AccountId } from "@0xhoneyjar/loa-hounfour"
import { type PoolId, POOL_IDS, isValidPoolId } from "@0xhoneyjar/loa-hounfour"

// ---------------------------------------------------------------------------
// Error Type
// ---------------------------------------------------------------------------

export class WireBoundaryError extends Error {
  constructor(
    public readonly field: string,
    public readonly raw: unknown,
    public readonly reason: string,
  ) {
    super(`Wire boundary violation: ${field} — ${reason}`)
    this.name = "WireBoundaryError"
  }
}

// ---------------------------------------------------------------------------
// MicroUSD — string ↔ branded bigint
// ---------------------------------------------------------------------------

// Canonical pattern: optional minus, then either "0" or a digit 1-9 followed by more digits
const MICRO_USD_PATTERN = /^-?(?:0|[1-9][0-9]*)$/

/**
 * Maximum length for MicroUSD string values (BB-026-iter2-003: symmetric DoS bounds).
 * Shared constant for consistent bounds across MicroUSD and CreditUnit parsers.
 */
export const MAX_MICRO_USD_LENGTH = 30

/**
 * Parse a raw string into a MicroUSD branded type.
 *
 * Normalization (SDD §4.1, PRD MicroUSD normalization table):
 * 1. Reject empty string
 * 2. Reject plus sign prefix ("+123" → error)
 * 3. Strip leading zeros ("007" → "7", "000" → "0")
 * 4. Normalize "-0" → "0"
 * 5. Validate canonical pattern: /^-?(?:0|[1-9][0-9]*)$/
 * 6. Return as MicroUSD branded type via BigInt conversion
 *
 * Negative values ARE allowed (deficit tracking). The upstream `microUSD()` factory
 * rejects negatives — this parse function is intentionally more permissive for
 * internal accounting while still enforcing wire format canonicalization.
 */
export function parseMicroUSD(raw: string): MicroUSD {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new WireBoundaryError("micro_usd", raw, "empty or non-string value")
  }

  // Reject plus sign prefix
  if (raw.startsWith("+")) {
    throw new WireBoundaryError("micro_usd", raw, "plus sign prefix not allowed")
  }

  // Determine sign and numeric part
  const isNegative = raw.startsWith("-")
  const digits = isNegative ? raw.slice(1) : raw

  if (digits.length === 0) {
    throw new WireBoundaryError("micro_usd", raw, "bare minus sign")
  }

  // Reject non-digit characters in the numeric part
  if (!/^[0-9]+$/.test(digits)) {
    throw new WireBoundaryError("micro_usd", raw, "contains non-digit characters")
  }

  // Strip leading zeros: "007" → "7", "000" → "0"
  const stripped = digits.replace(/^0+/, "") || "0"

  // Reconstruct canonical form
  let canonical = isNegative ? `-${stripped}` : stripped

  // Normalize "-0" → "0"
  if (canonical === "-0") {
    canonical = "0"
  }

  // Final validation against canonical pattern
  if (!MICRO_USD_PATTERN.test(canonical)) {
    throw new WireBoundaryError("micro_usd", raw, "does not match canonical pattern")
  }

  return BigInt(canonical) as MicroUSD
}

/**
 * Lenient MicroUSD parser for persistence read paths (SDD §4.1, SKP-005).
 *
 * Normalizes instead of rejecting non-canonical values. Emits a boolean
 * indicating whether normalization occurred (caller emits metrics).
 *
 * Transition plan: After 2 weeks of zero normalization events, switch
 * read paths to strict `parseMicroUSD`. Metrics-driven, not time-driven.
 */
export function parseMicroUSDLenient(raw: string): { value: MicroUSD; normalized: boolean } {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new WireBoundaryError("micro_usd", raw, "empty or non-string value (lenient)")
  }

  // Try strict parse first
  try {
    const value = parseMicroUSD(raw)
    return { value, normalized: false }
  } catch {
    // Lenient path: attempt BigInt conversion directly
  }

  // Strip whitespace
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new WireBoundaryError("micro_usd", raw, "whitespace-only value (lenient)")
  }

  // Bounds check: reject absurdly long strings before BigInt conversion (DoS prevention)
  if (trimmed.length > MAX_MICRO_USD_LENGTH) {
    throw new WireBoundaryError("micro_usd", raw, "value exceeds maximum length (lenient)")
  }

  // Try BigInt conversion after stripping plus sign
  const noPlusSign = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed
  try {
    const bigintValue = BigInt(noPlusSign)
    return { value: bigintValue as MicroUSD, normalized: true }
  } catch {
    throw new WireBoundaryError("micro_usd", raw, "cannot parse as integer (lenient)")
  }
}

/**
 * Serialize a MicroUSD value to canonical wire format string.
 * MicroUSD is bigint internally — serialize via toString().
 */
export function serializeMicroUSD(value: MicroUSD): string {
  return value.toString()
}

/**
 * Runtime format assertion for persistence write boundaries.
 * Validates that a string matches the canonical MicroUSD pattern.
 * Use this at WAL append, R2 upload, Redis write — anywhere data leaves the process.
 */
export function assertMicroUSDFormat(value: string): void {
  if (!MICRO_USD_PATTERN.test(value) || value === "-0") {
    throw new WireBoundaryError("micro_usd", value, "non-canonical format at persistence boundary")
  }
}

// ---------------------------------------------------------------------------
// MicroUSD Arithmetic Helpers (branded-safe wrappers)
// ---------------------------------------------------------------------------

/**
 * Add two MicroUSD values. Result preserves branding.
 * Allows negative results (deficit tracking).
 */
export function addMicroUSD(a: MicroUSD, b: MicroUSD): MicroUSD {
  return (a + b) as MicroUSD
}

/**
 * Subtract two MicroUSD values. Result preserves branding.
 * Allows negative results (deficit tracking) — unlike the upstream subtractMicroUSD
 * which throws on negative. Use upstream version when non-negative is required.
 */
export function subtractMicroUSD(a: MicroUSD, b: MicroUSD): MicroUSD {
  return (a - b) as MicroUSD
}

// ---------------------------------------------------------------------------
// BasisPoints — number ↔ branded bigint
// ---------------------------------------------------------------------------

/**
 * Parse a raw number into a BasisPoints branded type.
 * Validates: integer, range [0, 10000].
 */
export function parseBasisPoints(raw: number): BasisPoints {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new WireBoundaryError("basis_points", raw, "must be an integer")
  }
  if (raw < 0 || raw > 10000) {
    throw new WireBoundaryError("basis_points", raw, "must be in range [0, 10000]")
  }
  return BigInt(raw) as BasisPoints
}

/**
 * Serialize BasisPoints to number for wire format.
 */
export function serializeBasisPoints(value: BasisPoints): number {
  return Number(value)
}

// ---------------------------------------------------------------------------
// AccountId — string ↔ branded string
// ---------------------------------------------------------------------------

const ACCOUNT_ID_PATTERN = /^[^\s]+$/

/**
 * Parse a raw string into an AccountId branded type.
 * Validates: non-empty, no whitespace (matches upstream accountId() permissiveness).
 * Upstream factory only rejects empty — we add minimal whitespace rejection for wire safety.
 * Actual formats include: "community:thj", "tenant-abc", "local".
 */
export function parseAccountId(raw: string): AccountId {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new WireBoundaryError("account_id", raw, "empty or non-string value")
  }
  if (!ACCOUNT_ID_PATTERN.test(raw)) {
    throw new WireBoundaryError("account_id", raw, "must be non-empty with no whitespace")
  }
  return raw as AccountId
}

/**
 * Serialize AccountId to string for wire format.
 */
export function serializeAccountId(value: AccountId): string {
  return value as string
}

// ---------------------------------------------------------------------------
// PoolId — string ↔ canonical vocabulary member
// ---------------------------------------------------------------------------

/**
 * Parse a raw string into a PoolId (canonical vocabulary member).
 * PoolId is a union type, not a branded type — validates membership in POOL_IDS.
 */
export function parsePoolId(raw: string): PoolId {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new WireBoundaryError("pool_id", raw, "empty or non-string value")
  }
  if (!isValidPoolId(raw)) {
    throw new WireBoundaryError("pool_id", raw, `not a valid pool ID. Valid: ${POOL_IDS.join(", ")}`)
  }
  return raw
}
