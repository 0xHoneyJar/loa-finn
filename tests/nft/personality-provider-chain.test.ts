// tests/nft/personality-provider-chain.test.ts — Provider Chain Tests (Sprint 5 T5.6)

import { describe, it, expect } from "vitest"
import { PersonalityProviderChain } from "../../src/nft/personality-provider-chain.js"
import type { PersonalityProvider, PersonalityConfig } from "../../src/nft/personality-provider.js"

// ---------------------------------------------------------------------------
// Mock providers
// ---------------------------------------------------------------------------

function createMockProvider(
  data: Record<string, PersonalityConfig>,
): PersonalityProvider {
  return {
    async get(tokenId: string) {
      return data[tokenId] ?? null
    },
    async has(tokenId: string) {
      return tokenId in data
    },
  }
}

const FREETEKNO: PersonalityConfig = {
  token_id: "1",
  archetype: "freetekno",
  display_name: "Rave Spirit",
  voice_description: "Underground energy",
  behavioral_traits: ["rebellious"],
  expertise_domains: ["electronic music"],
  beauvoir_template: "You are a rave entity.",
}

const MILADY: PersonalityConfig = {
  token_id: "2",
  archetype: "milady",
  display_name: "Milady",
  voice_description: "Aesthetic irony",
  behavioral_traits: ["ironic"],
  expertise_domains: ["art"],
  beauvoir_template: "You are an aesthetic entity.",
}

const FREETEKNO_OVERRIDE: PersonalityConfig = {
  ...FREETEKNO,
  beauvoir_template: "Override: enhanced rave entity.",
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T5.6: PersonalityProviderChain — construction", () => {
  it("starts with no providers", () => {
    const chain = new PersonalityProviderChain()
    expect(chain.size).toBe(0)
  })

  it("addProvider increments size", () => {
    const chain = new PersonalityProviderChain()
    chain.addProvider("static", createMockProvider({}))
    expect(chain.size).toBe(1)
    chain.addProvider("redis", createMockProvider({}))
    expect(chain.size).toBe(2)
  })

  it("getProviderNames returns names in order", () => {
    const chain = new PersonalityProviderChain()
    chain.addProvider("static", createMockProvider({}))
    chain.addProvider("redis", createMockProvider({}))
    chain.addProvider("postgres", createMockProvider({}))
    expect(chain.getProviderNames()).toEqual(["static", "redis", "postgres"])
  })
})

describe("T5.6: PersonalityProviderChain — get()", () => {
  it("returns null when no providers", async () => {
    const chain = new PersonalityProviderChain()
    const result = await chain.get("1")
    expect(result).toBeNull()
  })

  it("returns result from first provider that has it", async () => {
    const chain = new PersonalityProviderChain()
    chain.addProvider("static", createMockProvider({ "1": FREETEKNO }))
    chain.addProvider("postgres", createMockProvider({ "2": MILADY }))

    const result = await chain.get("1")
    expect(result).not.toBeNull()
    expect(result!.archetype).toBe("freetekno")
  })

  it("falls through to second provider when first returns null", async () => {
    const chain = new PersonalityProviderChain()
    chain.addProvider("static", createMockProvider({})) // Empty — returns null
    chain.addProvider("postgres", createMockProvider({ "2": MILADY }))

    const result = await chain.get("2")
    expect(result).not.toBeNull()
    expect(result!.archetype).toBe("milady")
  })

  it("first provider wins when both have the same tokenId", async () => {
    const chain = new PersonalityProviderChain()
    chain.addProvider("static", createMockProvider({ "1": FREETEKNO }))
    chain.addProvider("postgres", createMockProvider({ "1": FREETEKNO_OVERRIDE }))

    const result = await chain.get("1")
    expect(result!.beauvoir_template).toBe("You are a rave entity.")
  })

  it("returns null when no provider has the tokenId", async () => {
    const chain = new PersonalityProviderChain()
    chain.addProvider("static", createMockProvider({ "1": FREETEKNO }))
    chain.addProvider("postgres", createMockProvider({ "2": MILADY }))

    const result = await chain.get("99")
    expect(result).toBeNull()
  })
})

describe("T5.6: PersonalityProviderChain — has()", () => {
  it("returns false when no providers", async () => {
    const chain = new PersonalityProviderChain()
    expect(await chain.has("1")).toBe(false)
  })

  it("returns true when any provider has the tokenId", async () => {
    const chain = new PersonalityProviderChain()
    chain.addProvider("static", createMockProvider({}))
    chain.addProvider("postgres", createMockProvider({ "2": MILADY }))

    expect(await chain.has("2")).toBe(true)
  })

  it("returns false when no provider has the tokenId", async () => {
    const chain = new PersonalityProviderChain()
    chain.addProvider("static", createMockProvider({ "1": FREETEKNO }))

    expect(await chain.has("99")).toBe(false)
  })
})

describe("T5.6: PersonalityProviderChain — full chain scenario", () => {
  it("StaticLoader → Redis → Postgres chain falls through correctly", async () => {
    // Static has token 1
    const staticProvider = createMockProvider({ "1": FREETEKNO })
    // Redis has token 2
    const redisProvider = createMockProvider({ "2": MILADY })
    // Postgres has token 3
    const pgProvider = createMockProvider({
      "3": {
        token_id: "3",
        archetype: "chicago_detroit",
        display_name: "Chi-Town",
        voice_description: "Deep house vibes",
        behavioral_traits: ["soulful"],
        expertise_domains: ["house music"],
        beauvoir_template: "You are a deep house entity.",
      },
    })

    const chain = new PersonalityProviderChain()
    chain.addProvider("static", staticProvider)
    chain.addProvider("redis", redisProvider)
    chain.addProvider("postgres", pgProvider)

    // Token 1 → static
    const r1 = await chain.get("1")
    expect(r1!.archetype).toBe("freetekno")

    // Token 2 → redis (static returns null, falls through)
    const r2 = await chain.get("2")
    expect(r2!.archetype).toBe("milady")

    // Token 3 → postgres (static + redis return null)
    const r3 = await chain.get("3")
    expect(r3!.archetype).toBe("chicago_detroit")

    // Token 99 → null (all return null)
    const r99 = await chain.get("99")
    expect(r99).toBeNull()
  })
})
