// src/nft/types.ts — NFT Personality Authoring Types (SDD §3.1, Sprint 1 Task 1.1)

import type {
  CompatibilityMode,
  SignalSnapshot,
  DAMPFingerprint,
  DerivedVoiceProfile,
} from "./signal-types.js"

// Re-export CompatibilityMode for convenience
export type { CompatibilityMode } from "./signal-types.js"

// ---------------------------------------------------------------------------
// Voice Types
// ---------------------------------------------------------------------------

/** Supported personality voice archetypes */
export type VoiceType = "analytical" | "creative" | "witty" | "sage"

const VALID_VOICES: ReadonlySet<string> = new Set<string>(["analytical", "creative", "witty", "sage"])

export function isValidVoice(v: unknown): v is VoiceType {
  return typeof v === "string" && VALID_VOICES.has(v)
}

// ---------------------------------------------------------------------------
// Personality Data
// ---------------------------------------------------------------------------

/** Max custom instructions length */
export const MAX_CUSTOM_INSTRUCTIONS = 2000

/** Max expertise domains */
export const MAX_EXPERTISE_DOMAINS = 5

/** NFT personality configuration */
export interface NFTPersonality {
  // === PRESERVED: Existing fields (unchanged shape) ===
  /** Composite key: `${collection}:${tokenId}` */
  id: string
  /** Display name for the agent */
  name: string
  /** Voice archetype (populated in both modes for API compat) */
  voice: VoiceType
  /** Expertise domains (up to 5) */
  expertise_domains: string[]
  /** Custom user instructions (max 2000 chars) */
  custom_instructions: string
  /** Generated BEAUVOIR.md content */
  beauvoir_md: string
  /** Creation timestamp (Unix ms) */
  created_at: number
  /** Last update timestamp (Unix ms) */
  updated_at: number

  // === NEW: Signal hierarchy (null in legacy_v1 mode) ===
  /** Full signal state — null when compatibility_mode is legacy_v1 */
  signals?: SignalSnapshot | null
  /** Derived 96-dial values — null when compatibility_mode is legacy_v1 */
  damp?: DAMPFingerprint | null

  // === NEW: Versioning ===
  /** Current version ID (ULID) */
  version_id?: string
  /** Link to previous version */
  previous_version_id?: string | null
  /** Wallet address that created/last modified */
  authored_by?: string

  // === NEW: Governance ===
  /** Governance model */
  governance_model?: "holder" | "community" | "dao"
  /** Compatibility mode discriminant */
  compatibility_mode?: CompatibilityMode

  // === NEW: Derived voice (null in legacy_v1 mode) ===
  /** Emergent voice profile from signals — null in legacy_v1 */
  voice_profile?: DerivedVoiceProfile | null
}

// ---------------------------------------------------------------------------
// Request / Response
// ---------------------------------------------------------------------------

/** Create personality request body */
export interface CreatePersonalityRequest {
  name: string
  voice: VoiceType
  expertise_domains: string[]
  custom_instructions?: string
}

/** Update personality request body */
export interface UpdatePersonalityRequest {
  name?: string
  voice?: VoiceType
  expertise_domains?: string[]
  custom_instructions?: string
  // === Sprint 4 Task 4.3: Signal-V2 auto-upgrade fields ===
  /** When provided, triggers auto-upgrade from legacy_v1 → signal_v2 (irreversible) */
  signals?: SignalSnapshot
  /** Derived 96-dial fingerprint (optional, can be computed externally) */
  damp?: DAMPFingerprint
  /** Derived voice profile (optional, can be computed externally) */
  voice_profile?: DerivedVoiceProfile
  /** Wallet address performing the upgrade */
  authored_by?: string
}

/** Personality API response */
export interface PersonalityResponse {
  id: string
  name: string
  voice: VoiceType
  expertise_domains: string[]
  custom_instructions: string
  created_at: number
  updated_at: number
  // === Sprint 4 Task 4.2: Extended response fields ===
  /** Full signal state — null for legacy_v1 personalities */
  signals: SignalSnapshot | null
  /** Derived 96-dial values — null for legacy_v1 personalities */
  damp: DAMPFingerprint | null
  /** Emergent voice profile from signals — null for legacy_v1 personalities */
  voice_profile: DerivedVoiceProfile | null
  /** Compatibility mode: legacy_v1 or signal_v2 */
  compatibility_mode: CompatibilityMode
  /** Current version ID (ULID) — null if unversioned */
  version_id: string | null
  /** Governance model: "holder" (enforced), "community", "dao" (accepted, not enforced) */
  governance_model: "holder" | "community" | "dao"
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type NFTPersonalityErrorCode =
  | "INVALID_REQUEST"
  | "PERSONALITY_NOT_FOUND"
  | "PERSONALITY_EXISTS"
  | "STORAGE_UNAVAILABLE"
  | "CODEX_UNCHANGED"
  | "MODE_INVALID"
  | "VERSION_NOT_FOUND"
  | "RATE_LIMITED"

const CODE_TO_STATUS: Record<NFTPersonalityErrorCode, number> = {
  INVALID_REQUEST: 400,
  PERSONALITY_NOT_FOUND: 404,
  PERSONALITY_EXISTS: 409,
  STORAGE_UNAVAILABLE: 503,
  CODEX_UNCHANGED: 409,
  MODE_INVALID: 400,
  VERSION_NOT_FOUND: 404,
  RATE_LIMITED: 429,
}

export class NFTPersonalityError extends Error {
  public readonly httpStatus: number
  constructor(
    public readonly code: NFTPersonalityErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "NFTPersonalityError"
    this.httpStatus = CODE_TO_STATUS[code]
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateCreateRequest(body: unknown): CreatePersonalityRequest {
  if (typeof body !== "object" || body === null) {
    throw new NFTPersonalityError("INVALID_REQUEST", "Request body must be a JSON object")
  }
  const b = body as Record<string, unknown>

  if (typeof b.name !== "string" || !b.name.trim()) {
    throw new NFTPersonalityError("INVALID_REQUEST", "name is required and must be a non-empty string")
  }

  if (!isValidVoice(b.voice)) {
    throw new NFTPersonalityError("INVALID_REQUEST", "voice must be one of: analytical, creative, witty, sage")
  }

  if (!Array.isArray(b.expertise_domains)) {
    throw new NFTPersonalityError("INVALID_REQUEST", "expertise_domains must be an array")
  }
  if (b.expertise_domains.length > MAX_EXPERTISE_DOMAINS) {
    throw new NFTPersonalityError("INVALID_REQUEST", `expertise_domains must have at most ${MAX_EXPERTISE_DOMAINS} entries`)
  }
  for (const d of b.expertise_domains) {
    if (typeof d !== "string" || !d.trim()) {
      throw new NFTPersonalityError("INVALID_REQUEST", "Each expertise domain must be a non-empty string")
    }
  }

  const customInstructions = typeof b.custom_instructions === "string" ? b.custom_instructions : ""
  if (customInstructions.length > MAX_CUSTOM_INSTRUCTIONS) {
    throw new NFTPersonalityError("INVALID_REQUEST", `custom_instructions must be at most ${MAX_CUSTOM_INSTRUCTIONS} characters`)
  }

  return {
    name: b.name.trim(),
    voice: b.voice,
    expertise_domains: b.expertise_domains.map((d: string) => d.trim()),
    custom_instructions: customInstructions,
  }
}

export function validateUpdateRequest(body: unknown): UpdatePersonalityRequest {
  if (typeof body !== "object" || body === null) {
    throw new NFTPersonalityError("INVALID_REQUEST", "Request body must be a JSON object")
  }
  const b = body as Record<string, unknown>
  const update: UpdatePersonalityRequest = {}

  if (b.name !== undefined) {
    if (typeof b.name !== "string" || !b.name.trim()) {
      throw new NFTPersonalityError("INVALID_REQUEST", "name must be a non-empty string")
    }
    update.name = b.name.trim()
  }

  if (b.voice !== undefined) {
    if (!isValidVoice(b.voice)) {
      throw new NFTPersonalityError("INVALID_REQUEST", "voice must be one of: analytical, creative, witty, sage")
    }
    update.voice = b.voice
  }

  if (b.expertise_domains !== undefined) {
    if (!Array.isArray(b.expertise_domains)) {
      throw new NFTPersonalityError("INVALID_REQUEST", "expertise_domains must be an array")
    }
    if (b.expertise_domains.length > MAX_EXPERTISE_DOMAINS) {
      throw new NFTPersonalityError("INVALID_REQUEST", `expertise_domains must have at most ${MAX_EXPERTISE_DOMAINS} entries`)
    }
    for (const d of b.expertise_domains) {
      if (typeof d !== "string" || !d.trim()) {
        throw new NFTPersonalityError("INVALID_REQUEST", "Each expertise domain must be a non-empty string")
      }
    }
    update.expertise_domains = b.expertise_domains.map((d: string) => d.trim())
  }

  if (b.custom_instructions !== undefined) {
    if (typeof b.custom_instructions !== "string") {
      throw new NFTPersonalityError("INVALID_REQUEST", "custom_instructions must be a string")
    }
    if (b.custom_instructions.length > MAX_CUSTOM_INSTRUCTIONS) {
      throw new NFTPersonalityError("INVALID_REQUEST", `custom_instructions must be at most ${MAX_CUSTOM_INSTRUCTIONS} characters`)
    }
    update.custom_instructions = b.custom_instructions
  }

  // Sprint 4 Task 4.3: Signal-V2 auto-upgrade fields (pass-through validation)
  if (b.signals !== undefined) {
    if (typeof b.signals !== "object" || b.signals === null) {
      throw new NFTPersonalityError("INVALID_REQUEST", "signals must be a non-null object")
    }
    update.signals = b.signals as SignalSnapshot
  }
  if (b.damp !== undefined) {
    if (typeof b.damp !== "object" || b.damp === null) {
      throw new NFTPersonalityError("INVALID_REQUEST", "damp must be a non-null object")
    }
    update.damp = b.damp as DAMPFingerprint
  }
  if (b.voice_profile !== undefined) {
    if (typeof b.voice_profile !== "object" || b.voice_profile === null) {
      throw new NFTPersonalityError("INVALID_REQUEST", "voice_profile must be a non-null object")
    }
    update.voice_profile = b.voice_profile as DerivedVoiceProfile
  }
  if (b.authored_by !== undefined) {
    if (typeof b.authored_by !== "string" || !b.authored_by.trim()) {
      throw new NFTPersonalityError("INVALID_REQUEST", "authored_by must be a non-empty string")
    }
    update.authored_by = b.authored_by.trim()
  }

  if (Object.keys(update).length === 0) {
    throw new NFTPersonalityError("INVALID_REQUEST", "At least one field must be provided for update")
  }

  return update
}
