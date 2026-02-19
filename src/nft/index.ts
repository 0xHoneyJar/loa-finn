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

// Codex Data Loader (Sprint 1 Task 1.5 + Sprint 7 Task 7.2)
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
  loadDAPMTables,
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
  decodePersonality,
  type PersonalityServiceDeps,
  // Sprint 4 Task 4.3b: V2 route handlers
  registerPersonalityV2Routes,
  handleCreateV2,
  handleUpdateV2,
  handleSynthesize,
  type PersonalityV2Deps,
  // Sprint 10: Identity Read API
  registerIdentityReadRoutes,
  type IdentityReadDeps,
  type IdentityGraphResponse,
} from "./personality.js"

// Personality Version Service (Sprint 3 Tasks 3.1-3.3)
export {
  PersonalityVersionService,
  VersionConflictError,
  generateUlid,
  type CreateVersionData,
  type VersionHistoryPage,
  type PersonalityVersionServiceDeps,
} from "./personality-version.js"

// Legacy VoiceType → dAPM Mapping (Sprint 4 Task 4.1)
export {
  getLegacyDAPMOffsets,
  LEGACY_VOICE_OFFSETS,
  getDAPMTables,
  resetDAPMTablesCache,
  type DAPMTablesData,
  type DialOffsetRecord,
  type PartialDialRecord,
} from "./dapm-tables.js"

// dAPM-96 Derivation Engine (Sprint 7 Tasks 7.1, 7.3-7.5 + Sprint 8 Task 8.1)
export {
  deriveDAPM,
  resolveAncestorFamily,
  normalizeSwag,
  deriveAstrologyBlend,
  clampModeOffset,
  ANCESTOR_TO_FAMILY,
  ANCESTOR_FAMILIES,
  type AncestorFamily,
  type KnowledgeGraph,
} from "./dapm.js"

// Personality Resolver (Task 4.3 + 4.4 + Sprint 11 Task 11.3)
export {
  resolvePersonalityPrompt,
  composeSystemPrompt,
  buildDAPMSummary,
  buildDistinctiveDialsSummary,
  type PersonalityResolverDeps,
} from "./personality-resolver.js"

// BEAUVOIR Synthesizer (Sprint 2 Tasks 2.1-2.3, 2.6)
export {
  BeauvoirSynthesizer,
  buildSynthesisPrompt,
  SynthesisError,
  type SynthesisRouter,
  type IdentitySubgraph as BeauvoirIdentitySubgraph,
  type UserCustomInput,
  type SynthesisErrorCode,
  type BeauvoirSynthesizerConfig,
} from "./beauvoir-synthesizer.js"

// Anti-Narration Framework (Sprint 2 Task 2.4)
export {
  validateAntiNarration,
  checkAN1,
  checkAN2,
  checkAN3,
  checkAN4,
  checkAN5,
  checkAN6,
  checkAN7,
  type ANViolation,
  type ANConstraintId,
} from "./anti-narration.js"

// Temporal Voice Domain Checker (Sprint 2 Task 2.5)
export {
  checkTemporalVoice,
  ERA_DOMAINS,
  type TemporalViolation,
  type EraDomainDef,
} from "./temporal-voice.js"

// Safety Policy (Sprint 8 Task 8.2)
export {
  getSafetyPolicy,
  getSafetyPolicyText,
  type SafetyPolicy,
  type SafetyRule,
} from "./safety-policy.js"

// Identity Graph — Knowledge Graph Integration (Sprint 9 Tasks 9.1-9.5 + Sprint 11 Task 11.2)
export {
  KnowledgeGraphLoader,
  extractSubgraph,
  toSynthesisSubgraph,
  resolveCulturalReferences,
  resolveAestheticPreferences,
  resolvePhilosophicalFoundations,
  IdentityGraphCache,
  type KnowledgeGraph as IdentityKnowledgeGraph,
  type GraphNode,
  type GraphEdge,
  type IdentitySubgraph,
  type SynthesisSubgraph,
  type DerivedEdge,
  type CulturalReference,
  type AestheticPreference,
  type PhilosophicalFoundation,
  type IdentityGraphCacheConfig,
} from "./identity-graph.js"

// On-Chain Ownership Provider (Sprint 6 Task 6.0)
export {
  type OwnershipProvider,
  EthersOwnershipProvider,
  MockOwnershipProvider,
  OwnershipError,
  type OwnershipErrorCode,
  type EthersOwnershipProviderConfig,
} from "./chain-config.js"
