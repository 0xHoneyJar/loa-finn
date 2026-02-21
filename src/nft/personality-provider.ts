// src/nft/personality-provider.ts — PersonalityProvider Interface (Sprint 4 T4.2)
//
// Minimal abstraction for personality resolution.
// v1 provider: StaticPersonalityLoader (reads config/personalities.json)
// v2 provider: SignalEngine (on-chain signals → dAMP → personality)

import type { Archetype } from "./signal-types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Static personality configuration entry from config/personalities.json */
export interface PersonalityConfig {
  token_id: string
  archetype: Archetype
  display_name: string
  voice_description: string
  behavioral_traits: string[]
  expertise_domains: string[]
  /** System prompt template injected into agent context */
  beauvoir_template: string
}

// ---------------------------------------------------------------------------
// Provider Interface
// ---------------------------------------------------------------------------

/**
 * PersonalityProvider — resolves a tokenId to a PersonalityConfig.
 *
 * Minimal abstraction: static loader is v1, signal engine becomes v2.
 * First non-null result from provider chain wins.
 */
export interface PersonalityProvider {
  /** Get personality config for a tokenId. Returns null if not found. */
  get(tokenId: string): Promise<PersonalityConfig | null>

  /** Check if a tokenId has a personality config. */
  has(tokenId: string): Promise<boolean>
}
