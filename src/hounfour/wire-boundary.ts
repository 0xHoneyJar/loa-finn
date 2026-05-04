// src/hounfour/wire-boundary.ts — Centralized Branded Type Parse/Serialize Layer (SDD §4.1)
//
// This module is the SOLE CONSTRUCTOR for branded type values in the application.
// Enforcement: type-level (brand not exported), lint-level (ESLint bans `as MicroUSD`),
// runtime-level (assertMicroUSDFormat at persistence boundaries).
//
// Design: Stripe pattern — module-private brand helper, parse at ingress, serialize at egress.

import type { BrandedMicroUSD as MicroUSD, BasisPoints, AccountId } from "@0xhoneyjar/loa-hounfour"
import { type PoolId, POOL_IDS, isValidPoolId } from "@0xhoneyjar/loa-hounfour"
import type { MicroUSDC } from "./protocol-types.js"
import { readMicroUSDC } from "./protocol-types.js"
import type { TaskType } from "./protocol-types.js"

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

  // Bounds check: reject absurdly long strings before BigInt conversion (DoS prevention)
  if (raw.length > MAX_MICRO_USD_LENGTH) {
    throw new WireBoundaryError("micro_usd", raw, "value exceeds maximum length")
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
// StrictMicroUSD — positive-only MicroUSD for wire boundaries (Sprint 2, Task 2.1)
// ---------------------------------------------------------------------------

declare const _strictMicroUSDBrand: unique symbol

/**
 * Nominally branded positive-only MicroUSD. Intersects the protocol
 * BrandedMicroUSD with a local unique symbol so that:
 *   - StrictMicroUSD IS assignable to MicroUSD / BrandedMicroUSD (superset)
 *   - MicroUSD IS NOT assignable to StrictMicroUSD (missing brand)
 *
 * Only `parseStrictMicroUSD()` can construct this type.
 */
export type StrictMicroUSD = MicroUSD & { readonly [_strictMicroUSDBrand]: true }

/**
 * Parse a raw string into a StrictMicroUSD branded type.
 *
 * Delegates to `parseMicroUSD()` for normalization and canonicalization,
 * then rejects negative values. This is the SOLE CONSTRUCTOR for
 * StrictMicroUSD — the only place the internal branding cast occurs.
 *
 * Use at wire egress boundaries where negative values must be rejected.
 */
export function parseStrictMicroUSD(raw: string): StrictMicroUSD {
  const value = parseMicroUSD(raw)
  if (value < 0n) {
    throw new WireBoundaryError("strict_micro_usd", raw, "negative values not allowed at strict boundary")
  }
  return value as StrictMicroUSD
}

/**
 * Serialize a StrictMicroUSD value to canonical wire format string.
 */
export function serializeStrictMicroUSD(value: StrictMicroUSD): string {
  return value.toString()
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
// CreditUnit — string ↔ branded bigint (Sprint 2, Task 2.1)
// User-facing balance unit: 100 CU = $1.00
// ---------------------------------------------------------------------------

declare const _creditUnitBrand: unique symbol
export type CreditUnit = bigint & { readonly [_creditUnitBrand]: true }

export const MAX_CREDIT_UNIT_LENGTH = MAX_MICRO_USD_LENGTH // symmetric DoS bounds

const CREDIT_UNIT_PATTERN = /^-?(?:0|[1-9][0-9]*)$/

export function parseCreditUnit(raw: string): CreditUnit {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new WireBoundaryError("credit_unit", raw, "empty or non-string value")
  }
  if (raw.startsWith("+")) {
    throw new WireBoundaryError("credit_unit", raw, "plus sign prefix not allowed")
  }
  if (raw.length > MAX_CREDIT_UNIT_LENGTH) {
    throw new WireBoundaryError("credit_unit", raw, "value exceeds maximum length")
  }
  const isNegative = raw.startsWith("-")
  const digits = isNegative ? raw.slice(1) : raw
  if (digits.length === 0) {
    throw new WireBoundaryError("credit_unit", raw, "bare minus sign")
  }
  if (!/^[0-9]+$/.test(digits)) {
    throw new WireBoundaryError("credit_unit", raw, "contains non-digit characters")
  }
  const stripped = digits.replace(/^0+/, "") || "0"
  let canonical = isNegative ? `-${stripped}` : stripped
  if (canonical === "-0") canonical = "0"
  if (!CREDIT_UNIT_PATTERN.test(canonical)) {
    throw new WireBoundaryError("credit_unit", raw, "does not match canonical pattern")
  }
  return BigInt(canonical) as CreditUnit
}

export function serializeCreditUnit(value: CreditUnit): string {
  return value.toString()
}

export function addCreditUnit(a: CreditUnit, b: CreditUnit): CreditUnit {
  return (a + b) as CreditUnit
}

export function subtractCreditUnit(a: CreditUnit, b: CreditUnit): CreditUnit {
  return (a - b) as CreditUnit
}

// ---------------------------------------------------------------------------
// MicroUSDC — string ↔ protocol branded bigint (Sprint 2, Task 2.3)
// On-chain settlement unit: 1 MicroUSDC = 0.000001 USDC (6 decimals)
// Type imported from @0xhoneyjar/loa-hounfour/economy (replaces local brand).
// ---------------------------------------------------------------------------

// Re-export protocol MicroUSDC type for backward-compatible import paths.
export type { MicroUSDC } from "./protocol-types.js"

/**
 * Parse a raw string into a protocol MicroUSDC branded type.
 *
 * Validates wire format (non-empty, no plus sign, length bound, digits only),
 * normalizes leading zeros, and delegates to protocol readMicroUSDC() for
 * non-negativity validation and branding.
 *
 * On-chain amounts are always non-negative — negatives are rejected.
 */
export function parseMicroUSDC(raw: string): MicroUSDC {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new WireBoundaryError("micro_usdc", raw, "empty or non-string value")
  }
  if (raw.startsWith("+")) {
    throw new WireBoundaryError("micro_usdc", raw, "plus sign prefix not allowed")
  }
  if (raw.length > MAX_MICRO_USD_LENGTH) {
    throw new WireBoundaryError("micro_usdc", raw, "value exceeds maximum length")
  }
  if (raw.startsWith("-")) {
    throw new WireBoundaryError("micro_usdc", raw, "negative values not allowed for on-chain amounts")
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new WireBoundaryError("micro_usdc", raw, "contains non-digit characters")
  }
  // Normalize leading zeros: "007" → "7", "000" → "0"
  const canonical = raw.replace(/^0+/, "") || "0"

  // Delegate to protocol for branding and non-negativity validation
  const result = readMicroUSDC(canonical)
  if (result === undefined) {
    throw new WireBoundaryError("micro_usdc", raw, "protocol validation failed")
  }
  return result
}

export function serializeMicroUSDC(value: MicroUSDC): string {
  return value.toString()
}

// ---------------------------------------------------------------------------
// Denomination Conversion (Sprint 2, Task 2.1)
// Explicit rate parameters support rate freeze per billing_entry_id
// ---------------------------------------------------------------------------

const MICRO_USD_PER_DOLLAR = 1_000_000n

/**
 * Convert MicroUSD to CreditUnit with explicit rate and rounding.
 *
 * Formula: creditUnits = microUSD * creditUnitsPerUsd / 1_000_000
 * RESERVE: ceil() — user never under-reserved
 * COMMIT: floor() — user never overpays by more than 1 CU
 */
export function convertMicroUSDtoCreditUnit(
  amount: MicroUSD,
  creditUnitsPerUsd: number,
  rounding: "ceil" | "floor" = "floor",
): CreditUnit {
  const rate = BigInt(creditUnitsPerUsd)
  const product = (amount as bigint) * rate
  if (rounding === "ceil") {
    // ceil division: (a + b - 1) / b
    const divisor = MICRO_USD_PER_DOLLAR
    const result = product >= 0n
      ? (product + divisor - 1n) / divisor
      : -((-product) / divisor) // negative ceil = -(floor of abs)
    return result as CreditUnit
  }
  // floor division (natural BigInt behavior for positive values)
  const result = product >= 0n
    ? product / MICRO_USD_PER_DOLLAR
    : -((-product + MICRO_USD_PER_DOLLAR - 1n) / MICRO_USD_PER_DOLLAR) // negative floor
  return result as CreditUnit
}

/**
 * Convert CreditUnit back to MicroUSD with explicit rate.
 * Used for: converting user-facing CU display back to internal denomination.
 */
export function convertCreditUnitToMicroUSD(
  amount: CreditUnit,
  creditUnitsPerUsd: number,
): MicroUSD {
  const rate = BigInt(creditUnitsPerUsd)
  return (((amount as bigint) * MICRO_USD_PER_DOLLAR) / rate) as MicroUSD
}

/**
 * Convert MicroUSD to MicroUSDC with explicit USD/USDC rate.
 *
 * Rate is expressed as MicroUSDC per USD (e.g. 1_000_000 = 1:1 peg).
 * Formula: microUSDC = microUSD * usdUsdcRate / 1_000_000
 *
 * Uses protocol readMicroUSDC() for branding and non-negativity validation.
 * On-chain amounts are always non-negative — negative inputs produce an error.
 */
export function convertMicroUSDtoMicroUSDC(
  amount: MicroUSD,
  usdUsdcRate: number,
  rounding: "ceil" | "floor" = "ceil",
): MicroUSDC {
  // On-chain amounts are always non-negative — reject negative input early
  // to prevent rounding from silently converting small negatives to 0.
  if ((amount as bigint) < 0n) {
    throw new WireBoundaryError("micro_usdc", amount.toString(), "negative MicroUSD not allowed for on-chain conversion")
  }
  // Rate as 6-decimal fixed point: 1.0 → 1_000_000
  const rate = BigInt(Math.round(usdUsdcRate * 1_000_000))
  const product = (amount as bigint) * rate
  const divisor = MICRO_USD_PER_DOLLAR // 10^6
  let result: bigint
  if (rounding === "ceil") {
    result = (product + divisor - 1n) / divisor
  } else {
    result = product / divisor
  }
  // Guard: result is bigint from BigInt arithmetic, so .toString() is safe
  // (no Number precision loss). Delegate to protocol for branding.
  const branded = readMicroUSDC(result.toString())
  if (branded === undefined) {
    throw new WireBoundaryError("micro_usdc", result.toString(), "conversion produced invalid MicroUSDC (negative input?)")
  }
  return branded
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

// ---------------------------------------------------------------------------
// TaskType — string ↔ branded governance task type (Sprint 2, Task 2.2)
// ---------------------------------------------------------------------------

const TASK_TYPE_MAX_LENGTH = 64
const TASK_TYPE_PATTERN = /^[a-z0-9_]+:[a-z0-9_]+$/

/**
 * Parse a raw string into a TaskType branded type.
 *
 * Validates `namespace:type` format (e.g., "finn:conversation").
 * Input is lowercased before validation.
 *
 * Constraints:
 * - Max 64 characters total
 * - Format: `namespace:type` where both parts are `[a-z0-9_]+`
 * - Namespace and type each must be 1+ characters
 *
 * This is the SOLE CONSTRUCTOR for TaskType in finn — the only place
 * the branding cast occurs.
 */
export function parseTaskType(raw: string): TaskType {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new WireBoundaryError("task_type", raw, "empty or non-string value")
  }

  const normalized = raw.toLowerCase()

  if (normalized.length > TASK_TYPE_MAX_LENGTH) {
    throw new WireBoundaryError("task_type", raw, `exceeds maximum length of ${TASK_TYPE_MAX_LENGTH} characters`)
  }

  if (!TASK_TYPE_PATTERN.test(normalized)) {
    throw new WireBoundaryError(
      "task_type",
      raw,
      "must match namespace:type format where namespace and type are [a-z0-9_]+ (1+ chars each)",
    )
  }

  return normalized as TaskType
}

// ---------------------------------------------------------------------------
// Task Type Registry (Sprint 2, Task 2.6)
// ---------------------------------------------------------------------------

/**
 * Finn-native task types, pre-parsed at module load.
 * Key is the short name (after colon), value is the full TaskType.
 */
export const FINN_TASK_TYPES: ReadonlyMap<string, TaskType> = new Map<string, TaskType>([
  ["conversation", parseTaskType("finn:conversation")],
  ["code_review", parseTaskType("finn:code_review")],
  ["analysis", parseTaskType("finn:analysis")],
  ["creative", parseTaskType("finn:creative")],
  ["summarization", parseTaskType("finn:summarization")],
  ["admin", parseTaskType("finn:admin")],
])

/** Default task type for unspecified requests. */
export const DEFAULT_TASK_TYPE: TaskType = FINN_TASK_TYPES.get("conversation")!

/**
 * Check whether a TaskType is a registered finn-native type.
 */
export function isRegisteredTaskType(taskType: TaskType): boolean {
  for (const registered of FINN_TASK_TYPES.values()) {
    if ((registered as string) === (taskType as string)) return true
  }
  return false
}

/**
 * Legacy string literal → TaskType mapping.
 * Maps old unnamespaced string literals to their finn-namespaced equivalents.
 */
export const LEGACY_TASK_TYPE_MAP: ReadonlyMap<string, TaskType> = new Map<string, TaskType>([
  ["conversation", parseTaskType("finn:conversation")],
  ["code_review", parseTaskType("finn:code_review")],
  ["analysis", parseTaskType("finn:analysis")],
  ["creative_writing", parseTaskType("finn:creative")],
  ["summarization", parseTaskType("finn:summarization")],
  ["admin", parseTaskType("finn:admin")],
])

/**
 * Resolve a legacy unnamespaced task type string to a TaskType.
 * Returns null if the legacy string is not recognized.
 */
export function resolveLegacyTaskType(legacy: string): TaskType | null {
  return LEGACY_TASK_TYPE_MAP.get(legacy) ?? null
}
