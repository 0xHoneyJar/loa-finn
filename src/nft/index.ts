// src/nft/index.ts — NFT Module Barrel Exports (Sprint 4)

// Types
export {
  type VoiceType,
  type NFTPersonality,
  type CreatePersonalityRequest,
  type UpdatePersonalityRequest,
  type PersonalityResponse,
  type NFTPersonalityErrorCode,
  NFTPersonalityError,
  isValidVoice,
  validateCreateRequest,
  validateUpdateRequest,
  MAX_CUSTOM_INSTRUCTIONS,
  MAX_EXPERTISE_DOMAINS,
} from "./types.js"

// BEAUVOIR Template
export {
  generateBeauvoirMd,
  DEFAULT_BEAUVOIR_MD,
} from "./beauvoir-template.js"

// Personality Service + Routes
export {
  PersonalityService,
  personalityRoutes,
  type PersonalityServiceDeps,
} from "./personality.js"

// Personality Resolver (Task 4.3)
export {
  resolvePersonalityPrompt,
  composeSystemPrompt,
  type PersonalityResolverDeps,
} from "./personality-resolver.js"
