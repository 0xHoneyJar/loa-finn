// src/nft/schemas.ts — Runtime Validation for Personality Types (Bridge medium-6, Sprint 3 T3.2)
//
// Lightweight runtime validation for signal and personality types at API boundaries.
// Replaces `as SignalSnapshot` type assertions with validated parsing.
// No external dependencies — hand-rolled validators matching the type system.

import {
  type SignalSnapshot,
  type DAMPDialId,
  type DAMPFingerprint,
  type DerivedVoiceProfile,
  ARCHETYPES,
  ZODIAC_SIGNS,
  DAMP_DIAL_IDS,
} from "./signal-types.js"

// ---------------------------------------------------------------------------
// Validation Error
// ---------------------------------------------------------------------------

export class SignalValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Signal validation failed: ${field} — ${reason}`)
    this.name = "SignalValidationError"
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SignalValidationError(field, "must be a non-empty string")
  }
  return value
}

function assertNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new SignalValidationError(field, "must be a number")
  }
  return value
}

function assertInArray<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const str = assertString(value, field)
  if (!allowed.includes(str as T)) {
    throw new SignalValidationError(field, `must be one of: ${allowed.join(", ")}`)
  }
  return str as T
}

// ---------------------------------------------------------------------------
// SignalSnapshot Validator (12 required fields)
// ---------------------------------------------------------------------------

const ERAS = ["ancient", "medieval", "early_modern", "modern", "contemporary"] as const
const ELEMENTS = ["fire", "water", "air", "earth"] as const
const SWAG_RANKS = ["SSS", "SS", "S", "A", "B", "C", "D", "F"] as const
const TAROT_SUITS = ["wands", "cups", "swords", "pentacles", "major"] as const

/**
 * Validate and parse a raw object into a SignalSnapshot.
 * Throws SignalValidationError with specific field name on failure.
 */
export function parseSignalSnapshot(raw: unknown): SignalSnapshot {
  if (typeof raw !== "object" || raw === null) {
    throw new SignalValidationError("SignalSnapshot", "must be a non-null object")
  }

  const obj = raw as Record<string, unknown>

  // Tier 1: Load-bearing
  const archetype = assertInArray(obj.archetype, "archetype", ARCHETYPES)
  const ancestor = assertString(obj.ancestor, "ancestor")
  const birthday = assertString(obj.birthday, "birthday")
  const era = assertInArray(obj.era, "era", ERAS)

  // Tier 2: Textural
  const molecule = assertString(obj.molecule, "molecule")

  // Tarot card (nested object)
  if (typeof obj.tarot !== "object" || obj.tarot === null) {
    throw new SignalValidationError("tarot", "must be a non-null object")
  }
  const tarotObj = obj.tarot as Record<string, unknown>
  const tarot = {
    name: assertString(tarotObj.name, "tarot.name"),
    number: assertNumber(tarotObj.number, "tarot.number"),
    suit: assertInArray(tarotObj.suit, "tarot.suit", TAROT_SUITS),
    element: assertInArray(tarotObj.element, "tarot.element", ELEMENTS),
  }

  const element = assertInArray(obj.element, "element", ELEMENTS)

  // Tier 3: Modifier
  const swag_rank = assertInArray(obj.swag_rank, "swag_rank", SWAG_RANKS)
  const swag_score = assertNumber(obj.swag_score, "swag_score")
  if (swag_score < 0 || swag_score > 100) {
    throw new SignalValidationError("swag_score", "must be between 0 and 100")
  }
  const sun_sign = assertInArray(obj.sun_sign, "sun_sign", ZODIAC_SIGNS)
  const moon_sign = assertInArray(obj.moon_sign, "moon_sign", ZODIAC_SIGNS)
  const ascending_sign = assertInArray(obj.ascending_sign, "ascending_sign", ZODIAC_SIGNS)

  return {
    archetype,
    ancestor,
    birthday,
    era,
    molecule,
    tarot,
    element,
    swag_rank,
    swag_score,
    sun_sign,
    moon_sign,
    ascending_sign,
  }
}

// ---------------------------------------------------------------------------
// DAMPFingerprint Validator (96 dials, each 0.0-1.0)
// ---------------------------------------------------------------------------

/**
 * Validate and parse a raw object into a DAMPFingerprint.
 * Verifies all 96 dials are present and within [0.0, 1.0].
 */
export function parseDAMPFingerprint(raw: unknown): DAMPFingerprint {
  if (typeof raw !== "object" || raw === null) {
    throw new SignalValidationError("DAMPFingerprint", "must be a non-null object")
  }

  const obj = raw as Record<string, unknown>

  // Validate dials object
  if (typeof obj.dials !== "object" || obj.dials === null) {
    throw new SignalValidationError("dials", "must be a non-null object")
  }
  const dialsObj = obj.dials as Record<string, unknown>

  const dials: Record<DAMPDialId, number> = {} as Record<DAMPDialId, number>

  for (const dialId of DAMP_DIAL_IDS) {
    const value = dialsObj[dialId]
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new SignalValidationError(`dials.${dialId}`, "must be a number")
    }
    if (value < 0.0 || value > 1.0) {
      throw new SignalValidationError(`dials.${dialId}`, "must be between 0.0 and 1.0")
    }
    dials[dialId] = value
  }

  // Optional fields
  const mode = obj.mode !== undefined ? assertString(obj.mode, "mode") : undefined
  const derived_from = obj.derived_from !== undefined ? assertString(obj.derived_from, "derived_from") : undefined
  const derived_at = obj.derived_at !== undefined ? assertNumber(obj.derived_at, "derived_at") : undefined

  return {
    dials,
    ...(mode !== undefined && { mode }),
    ...(derived_from !== undefined && { derived_from }),
    ...(derived_at !== undefined && { derived_at }),
  } as DAMPFingerprint
}

// ---------------------------------------------------------------------------
// DerivedVoiceProfile Validator
// ---------------------------------------------------------------------------

const VOICE_TYPES = ["analytical", "creative", "witty", "sage"] as const

/**
 * Validate and parse a raw object into a DerivedVoiceProfile.
 */
export function parseDerivedVoiceProfile(raw: unknown): DerivedVoiceProfile {
  if (typeof raw !== "object" || raw === null) {
    throw new SignalValidationError("DerivedVoiceProfile", "must be a non-null object")
  }

  const obj = raw as Record<string, unknown>

  const primary_voice = assertInArray(obj.primary_voice, "primary_voice", VOICE_TYPES)
  const confidence = assertNumber(obj.confidence, "confidence")
  if (confidence < 0.0 || confidence > 1.0) {
    throw new SignalValidationError("confidence", "must be between 0.0 and 1.0")
  }

  const reasoning = assertString(obj.reasoning, "reasoning")

  return {
    primary_voice,
    confidence,
    reasoning,
  } as DerivedVoiceProfile
}
