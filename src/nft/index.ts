// src/nft/index.ts — NFT Module Barrel Exports (Sprint 4 + Sprint 1 cycle-028)

// Types
export {
  type VoiceType,
  type NFTPersonality,
  type CreatePersonalityRequest,
  type UpdatePersonalityRequest,
  type PersonalityResponse,
  type NFTPersonalityErrorCode,
  type CompatibilityMode,
  NFTPersonalityError,
  isValidVoice,
  validateCreateRequest,
  validateUpdateRequest,
  MAX_CUSTOM_INSTRUCTIONS,
  MAX_EXPERTISE_DOMAINS,
} from "./types.js"

// Signal & Identity Types (Sprint 1 Task 1.2)
export {
  type Archetype,
  type Era,
  type Element,
  type SwagRank,
  type ZodiacSign,
  type AgentMode,
  type TarotCard,
  type SignalSnapshot,
  type SignalCore8,
  type DAPMDialId,
  type DAPMFingerprint,
  type DerivedVoiceProfile,
  type PersonalityVersion,
  ARCHETYPES,
  ERA_BOUNDARIES,
  SWAG_RANK_VALUES,
  ZODIAC_SIGNS,
  DAPM_DIAL_IDS,
} from "./signal-types.js"

// Signal Engine (Sprint 1 Tasks 1.3 + 1.4)
export {
  buildSignalSnapshot,
  projectSignals,
  deriveEra,
  deriveTarot,
  deriveElement,
  deriveArchetypeAffinity,
  resolveAncestorConnection,
  propagateIdentityChain,
  resetSignalEngineCaches,
  type OnChainMetadata,
  type ArchetypeAffinityResult,
  type AncestorConnection,
  type IdentityChain,
} from "./signal-engine.js"

// Codex Data Loader (Sprint 1 Task 1.5)
export {
  registerArtifact,
  loadArtifact,
  getRegisteredArtifacts,
  clearArtifactCache,
  loadMoleculeTarotBijection,
  loadAncestors,
  loadArchetypeDefinitions,
  loadArchetypeAffinity,
  loadCodexVersion,
} from "./codex-data/loader.js"

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
