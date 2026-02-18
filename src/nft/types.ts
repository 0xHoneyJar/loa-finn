// src/nft/types.ts — NFT Personality Authoring Types (SDD §3.2, Sprint 4 Task 4.1)

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
  /** Composite key: `${collection}:${tokenId}` */
  id: string
  /** Display name for the agent */
  name: string
  /** Voice archetype */
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
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type NFTPersonalityErrorCode =
  | "INVALID_REQUEST"
  | "PERSONALITY_NOT_FOUND"
  | "PERSONALITY_EXISTS"
  | "STORAGE_UNAVAILABLE"

const CODE_TO_STATUS: Record<NFTPersonalityErrorCode, number> = {
  INVALID_REQUEST: 400,
  PERSONALITY_NOT_FOUND: 404,
  PERSONALITY_EXISTS: 409,
  STORAGE_UNAVAILABLE: 503,
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

  if (Object.keys(update).length === 0) {
    throw new NFTPersonalityError("INVALID_REQUEST", "At least one field must be provided for update")
  }

  return update
}
