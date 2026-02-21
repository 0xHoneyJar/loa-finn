// src/nft/personality-context.ts — Personality Context for Hounfour Protocol v4.5 Extension
// (Sprint 27 Task 27.1: Personality Fingerprint Protocol)
//
// PersonalityContext is an optional extension field for hounfour protocol messages.
// When a personality is available, it carries the dAMP fingerprint hash, archetype,
// and dominant dimensions for downstream routing and quality correlation.
// When personality is unavailable, personality_context is null — never undefined.

import type { Archetype } from "./signal-types.js"
import type { DAMPFingerprint, DAMPDialId } from "./signal-types.js"
import { DAMP_DIAL_IDS } from "./signal-types.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Protocol version for this extension */
export const PERSONALITY_CONTEXT_VERSION = "4.5" as const

/** Number of top dials to include as dominant dimensions */
export const DOMINANT_DIMENSION_COUNT = 5

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single dominant dimension extracted from the dAMP fingerprint */
export interface DominantDimension {
  /** Dial identifier (e.g., "cr_divergent_thinking") */
  dial_id: DAMPDialId
  /** Dial value (0.0-1.0) */
  value: number
}

/**
 * PersonalityContext — optional extension for hounfour protocol v4.5.
 *
 * Carried alongside synthesis requests to enable:
 * - Quality correlation (fingerprint_hash + model -> quality_score)
 * - Downstream routing awareness (archetype, dominant dimensions)
 *
 * This field is null when personality is not available (e.g., legacy_v1,
 * anonymous users, system prompts without personality).
 */
export interface PersonalityContext {
  /** Composite key: `${collection}:${tokenId}` */
  personality_id: string
  /** SHA-256 hash of the serialized dAMP fingerprint dials (hex, lowercase) */
  damp_fingerprint_hash: string
  /** Primary archetype from the signal snapshot */
  archetype: Archetype
  /** Top N dials by value from the dAMP fingerprint, sorted descending */
  dominant_dimensions: DominantDimension[]
  /** Protocol version that produced this context */
  protocol_version: typeof PERSONALITY_CONTEXT_VERSION
  /**
   * Per-pool routing affinity scores [0-1], computed from archetype + genotype.
   * Used by HounfourRouter to select personality-optimal pools.
   * Undefined when fingerprint is unavailable (legacy_v1 personalities).
   * Sprint 2 (GID 122), Task T2.3.
   * Keys are PoolId strings from loa-hounfour vocabulary.
   */
  routing_affinity?: Record<string, number>
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash of the dAMP fingerprint dials.
 * Sorts dial IDs lexicographically, concatenates "dial_id:value" pairs
 * (value rounded to 6 decimal places), then SHA-256 hashes the result.
 *
 * Uses the Web Crypto API (globalThis.crypto.subtle) when available,
 * otherwise falls back to Node.js crypto.
 */
export async function computeFingerprintHash(fingerprint: DAMPFingerprint): Promise<string> {
  const sortedKeys = Object.keys(fingerprint.dials).sort() as DAMPDialId[]
  const canonical = sortedKeys
    .map(k => `${k}:${fingerprint.dials[k].toFixed(6)}`)
    .join("|")

  // Use Node.js crypto (always available in this runtime)
  const { createHash } = await import("node:crypto")
  const hash = createHash("sha256").update(canonical).digest("hex")
  return hash
}

/**
 * Synchronous version using Node.js crypto directly.
 * Preferred for hot paths where async is undesirable.
 */
export function computeFingerprintHashSync(fingerprint: DAMPFingerprint): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto")
  const sortedKeys = Object.keys(fingerprint.dials).sort() as DAMPDialId[]
  const canonical = sortedKeys
    .map(k => `${k}:${fingerprint.dials[k].toFixed(6)}`)
    .join("|")
  return createHash("sha256").update(canonical).digest("hex")
}

/**
 * Extract the top N dominant dimensions from a dAMP fingerprint.
 * Returns dials sorted by value descending. Ties broken by dial_id ascending.
 */
export function extractDominantDimensions(
  fingerprint: DAMPFingerprint,
  count: number = DOMINANT_DIMENSION_COUNT,
): DominantDimension[] {
  const entries: DominantDimension[] = DAMP_DIAL_IDS
    .filter(id => id in fingerprint.dials)
    .map(id => ({ dial_id: id, value: fingerprint.dials[id] }))

  entries.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value
    return a.dial_id.localeCompare(b.dial_id)
  })

  return entries.slice(0, count)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a PersonalityContext from personality data.
 * Returns null if required inputs are missing (personality not available).
 *
 * @param personalityId - Composite key `collection:tokenId`
 * @param archetype - Primary archetype from signal snapshot
 * @param fingerprint - dAMP fingerprint (null if not derived)
 * @param routingAffinity - Pre-computed routing affinity (from computeRoutingAffinity)
 * @returns PersonalityContext or null
 */
export async function buildPersonalityContext(
  personalityId: string,
  archetype: Archetype,
  fingerprint: DAMPFingerprint | null,
  routingAffinity?: Record<string, number>,
): Promise<PersonalityContext | null> {
  if (!fingerprint) return null

  const hash = await computeFingerprintHash(fingerprint)
  const dominant = extractDominantDimensions(fingerprint)

  return {
    personality_id: personalityId,
    damp_fingerprint_hash: hash,
    archetype,
    dominant_dimensions: dominant,
    protocol_version: PERSONALITY_CONTEXT_VERSION,
    routing_affinity: routingAffinity,
  }
}

/**
 * Synchronous variant for hot paths.
 */
export function buildPersonalityContextSync(
  personalityId: string,
  archetype: Archetype,
  fingerprint: DAMPFingerprint | null,
  routingAffinity?: Record<string, number>,
): PersonalityContext | null {
  if (!fingerprint) return null

  const hash = computeFingerprintHashSync(fingerprint)
  const dominant = extractDominantDimensions(fingerprint)

  return {
    personality_id: personalityId,
    damp_fingerprint_hash: hash,
    archetype,
    dominant_dimensions: dominant,
    protocol_version: PERSONALITY_CONTEXT_VERSION,
    routing_affinity: routingAffinity,
  }
}

// ---------------------------------------------------------------------------
// Serialization Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize PersonalityContext to a JSON-safe object.
 * Echo semantics: serialize(deserialize(x)) === x for any valid context.
 */
export function serializePersonalityContext(
  ctx: PersonalityContext | null,
): Record<string, unknown> | null {
  if (!ctx) return null
  return {
    personality_id: ctx.personality_id,
    damp_fingerprint_hash: ctx.damp_fingerprint_hash,
    archetype: ctx.archetype,
    dominant_dimensions: ctx.dominant_dimensions.map(d => ({
      dial_id: d.dial_id,
      value: d.value,
    })),
    protocol_version: ctx.protocol_version,
  }
}

/**
 * Deserialize a raw JSON object back to PersonalityContext.
 * Returns null if the input is null or missing required fields.
 * Enforces protocol_version gating: only "4.5" is accepted.
 */
export function deserializePersonalityContext(
  raw: Record<string, unknown> | null | undefined,
): PersonalityContext | null {
  if (!raw) return null
  if (typeof raw !== "object") return null

  // Protocol version gate
  if (raw.protocol_version !== PERSONALITY_CONTEXT_VERSION) return null

  // Required field validation
  if (typeof raw.personality_id !== "string") return null
  if (typeof raw.damp_fingerprint_hash !== "string") return null
  if (typeof raw.archetype !== "string") return null
  if (!Array.isArray(raw.dominant_dimensions)) return null

  const dimensions: DominantDimension[] = []
  for (const d of raw.dominant_dimensions) {
    if (
      typeof d === "object" && d !== null &&
      typeof (d as Record<string, unknown>).dial_id === "string" &&
      typeof (d as Record<string, unknown>).value === "number"
    ) {
      dimensions.push({
        dial_id: (d as Record<string, unknown>).dial_id as DAMPDialId,
        value: (d as Record<string, unknown>).value as number,
      })
    }
  }

  return {
    personality_id: raw.personality_id as string,
    damp_fingerprint_hash: raw.damp_fingerprint_hash as string,
    archetype: raw.archetype as Archetype,
    dominant_dimensions: dimensions,
    protocol_version: PERSONALITY_CONTEXT_VERSION,
  }
}
