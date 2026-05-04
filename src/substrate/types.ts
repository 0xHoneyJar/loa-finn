// src/substrate/types.ts — Internal types for substrate-construct loader/runtime.
// Cycle-032 Sprint-1 Task 1.2. See PRD FR-1 + SDD §4.1 + build doc §5.2.

import type { z } from "zod"
import type { packManifestSchema } from "./manifest-schema.js"

/**
 * Validated pack manifest after Zod parse + substrate-construct conditional refinement.
 * Inferred from the schema; refines the type so substrate-construct fields are required.
 */
export type ValidatedPackManifest = z.infer<typeof packManifestSchema>

/**
 * License tier per cycle-1 contract. Determines grace-period seconds.
 */
export type LicenseTier = "individual" | "pro" | "team" | "enterprise"

/**
 * Tier grace-period seconds per cycle-1 substrate-integration contract.
 * Per `~/Documents/GitHub/loa-constructs/.claude/protocols/constructs-integration.md`.
 */
export const TIER_GRACE_SECONDS: Record<LicenseTier, number> = {
  individual: 24 * 3600,
  pro: 24 * 3600,
  team: 72 * 3600,
  enterprise: 168 * 3600,
}

/**
 * Validation status returned by the JWT validator.
 *
 * - `valid`: license is currently within `nbf .. exp`. Cached with TTL = min(exp-now, 1h).
 * - `validatedWithGrace`: license is within `exp .. exp + grace`. Cached with TTL = min(exp+grace-now, 1h).
 *   Caller should treat this as functionally usable but log a warning so the operator can renew.
 */
export type ValidationStatus = "valid" | "validatedWithGrace"

export interface ValidatedLicense {
  fingerprint: string
  kid: string
  issuedAt: Date
  expiresAt: Date
  graceUntil: Date
  tier: LicenseTier
  status: ValidationStatus
}

export interface LoadedConstruct {
  slug: string
  manifest: ValidatedPackManifest
  /** realpath-canonicalized absolute path to the entry module */
  entryPath: string
  /** memoized dynamic import — first call does `await import(pathToFileURL(entryPath))`, subsequent calls return same module */
  loadModule: () => Promise<Record<string, unknown>>
  license: ValidatedLicense
}

// ── Typed errors with `_tag` discriminators ──────────────────────────

export class ManifestParseError extends Error {
  readonly _tag = "ManifestParseError"
  constructor(
    readonly packDir: string,
    readonly cause: unknown,
  ) {
    super(`Failed to parse manifest in ${packDir}: ${String(cause)}`)
    this.name = "ManifestParseError"
  }
}

export class ManifestValidationError extends Error {
  readonly _tag = "ManifestValidationError"
  constructor(
    readonly packDir: string,
    readonly issues: z.ZodIssue[],
  ) {
    super(
      `Manifest validation failed in ${packDir}:\n${issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`,
    )
    this.name = "ManifestValidationError"
  }
}

export class LicenseError extends Error {
  readonly _tag = "LicenseError"
  constructor(
    readonly reason: string,
    readonly cause?: unknown,
  ) {
    super(`License rejected: ${reason}`)
    this.name = "LicenseError"
  }
}

export class EntryResolutionError extends Error {
  readonly _tag = "EntryResolutionError"
  constructor(
    readonly entry: string,
    readonly reason: string,
  ) {
    super(`Cannot resolve executable.entry "${entry}": ${reason}`)
    this.name = "EntryResolutionError"
  }
}

/**
 * Thrown by the runtime when a construct declares a `requirements[].tag` that
 * the loader doesn't recognize. Per PRD FR-2 capability rule.
 */
export class UnknownRequirementError extends Error {
  readonly _tag = "UnknownRequirementError"
  constructor(readonly tag: string) {
    super(`Unknown requirement tag: "${tag}". Loader recognizes ModelRunner, EventWriter (capability-bound) and Logger, Clock (ambient).`)
    this.name = "UnknownRequirementError"
  }
}
