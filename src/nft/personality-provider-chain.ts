// src/nft/personality-provider-chain.ts — Provider Chain (Sprint 5 T5.6)
//
// Chains multiple PersonalityProvider implementations.
// First non-null result wins. Providers tried in registration order.
// Default chain: StaticPersonalityLoader → PersonalityStore (Redis → Postgres).

import type { PersonalityProvider, PersonalityConfig } from "./personality-provider.js"

// ---------------------------------------------------------------------------
// PersonalityProviderChain
// ---------------------------------------------------------------------------

export class PersonalityProviderChain implements PersonalityProvider {
  private readonly providers: Array<{ name: string; provider: PersonalityProvider }> = []

  /**
   * Add a provider to the chain. Providers are tried in registration order.
   */
  addProvider(name: string, provider: PersonalityProvider): void {
    this.providers.push({ name, provider })
  }

  /**
   * Get personality config from the first provider that returns a result.
   * Returns null if no provider has a config for this tokenId.
   */
  async get(tokenId: string): Promise<PersonalityConfig | null> {
    for (const { provider } of this.providers) {
      const result = await provider.get(tokenId)
      if (result !== null) {
        return result
      }
    }
    return null
  }

  /**
   * Check if any provider has a config for this tokenId.
   */
  async has(tokenId: string): Promise<boolean> {
    for (const { provider } of this.providers) {
      if (await provider.has(tokenId)) {
        return true
      }
    }
    return false
  }

  /**
   * Get the number of registered providers.
   */
  get size(): number {
    return this.providers.length
  }

  /**
   * Get registered provider names in order.
   */
  getProviderNames(): string[] {
    return this.providers.map((p) => p.name)
  }
}
