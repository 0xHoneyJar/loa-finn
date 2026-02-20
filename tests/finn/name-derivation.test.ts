// tests/finn/name-derivation.test.ts — Self-Derived Agent Naming Tests (Sprint 18 Tasks 18.1-18.2)

import { describe, it, expect } from "vitest"
import {
  nameKDF,
  getNameCorpus,
  validateCorpusCoverage,
  type NameCorpus,
} from "../../src/nft/name-derivation.js"
import { ARCHETYPES } from "../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Known ancestor list (33 ancestors from mibera-codex)
// ---------------------------------------------------------------------------

const ANCESTORS = [
  "greek_philosopher", "celtic_druid", "buddhist_monk", "egyptian_priest",
  "norse_skald", "sufi_mystic", "taoist_sage", "aboriginal_elder",
  "vedic_rishi", "alchemist", "zen_master", "mayan_astronomer",
  "yoruba_babalawo", "renaissance_polymath", "stoic_philosopher",
  "shamanic_healer", "confucian_scholar", "german_idealist", "cypherpunk",
  "beat_poet", "vodou_priestess", "navajo_singer", "tantric_adept",
  "japanese_aesthetic", "situationist", "amazonian_curandero", "sufi_poet",
  "pythagorean", "afrofuturist", "hermetic_magician", "cynical_philosopher",
  "rave_shaman", "techno_philosopher",
] as const

const COLLECTION_SALT = "test-collection-salt-v1"

// ---------------------------------------------------------------------------
// Task 18.1: Corpus Coverage Tests
// ---------------------------------------------------------------------------

describe("Name Corpus (Task 18.1)", () => {
  it("covers all 4 archetypes × 33 ancestors = 132 pairs", () => {
    const result = validateCorpusCoverage(ARCHETYPES, ANCESTORS)
    expect(result.missing).toEqual([])
    expect(result.covered).toBe(132)
  })

  it("each pair has ≥10 name candidates", () => {
    const result = validateCorpusCoverage(ARCHETYPES, ANCESTORS)
    expect(result.minCandidates).toBeGreaterThanOrEqual(10)
  })

  it("corpus keys follow archetype:ancestor format", () => {
    const corpus = getNameCorpus()
    for (const key of Object.keys(corpus)) {
      expect(key).toMatch(/^[a-z_]+:[a-z_]+$/)
    }
  })

  it("each component has a non-empty root", () => {
    const corpus = getNameCorpus()
    for (const [key, components] of Object.entries(corpus)) {
      for (const comp of components) {
        expect(comp.root, `empty root in ${key}`).toBeTruthy()
        expect(typeof comp.root).toBe("string")
      }
    }
  })

  it("prefixes and suffixes are optional but typed correctly", () => {
    const corpus = getNameCorpus()
    for (const components of Object.values(corpus)) {
      for (const comp of components) {
        if (comp.prefix !== undefined) {
          expect(typeof comp.prefix).toBe("string")
          expect(comp.prefix.length).toBeGreaterThan(0)
        }
        if (comp.suffix !== undefined) {
          expect(typeof comp.suffix).toBe("string")
          expect(comp.suffix.length).toBeGreaterThan(0)
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Task 18.2: NameKDF Determinism Tests
// ---------------------------------------------------------------------------

describe("NameKDF Determinism (Task 18.2)", () => {
  it("same inputs produce same name (deterministic)", () => {
    const name1 = nameKDF("freetekno", "greek_philosopher", "ancient", "psilocybin", "fire", "42", COLLECTION_SALT)
    const name2 = nameKDF("freetekno", "greek_philosopher", "ancient", "psilocybin", "fire", "42", COLLECTION_SALT)
    expect(name1).toBe(name2)
  })

  it("different tokenIds produce different names", () => {
    const name1 = nameKDF("freetekno", "greek_philosopher", "ancient", "psilocybin", "fire", "1", COLLECTION_SALT)
    const name2 = nameKDF("freetekno", "greek_philosopher", "ancient", "psilocybin", "fire", "2", COLLECTION_SALT)
    expect(name1).not.toBe(name2)
  })

  it("different archetypes produce different names", () => {
    const name1 = nameKDF("freetekno", "greek_philosopher", "ancient", "psilocybin", "fire", "42", COLLECTION_SALT)
    const name2 = nameKDF("milady", "greek_philosopher", "ancient", "psilocybin", "fire", "42", COLLECTION_SALT)
    expect(name1).not.toBe(name2)
  })

  it("different collection salts produce different names", () => {
    const name1 = nameKDF("freetekno", "greek_philosopher", "ancient", "psilocybin", "fire", "42", "salt-a")
    const name2 = nameKDF("freetekno", "greek_philosopher", "ancient", "psilocybin", "fire", "42", "salt-b")
    expect(name1).not.toBe(name2)
  })

  it("returns a non-empty string with disambiguator", () => {
    const name = nameKDF("milady", "celtic_druid", "medieval", "ayahuasca", "water", "100", COLLECTION_SALT)
    expect(name).toBeTruthy()
    expect(name.length).toBeGreaterThan(4)
    // Should end with -XXXX disambiguator
    expect(name).toMatch(/-\d{4}$/)
  })

  it("name is selected from correct archetype×ancestor corpus partition", () => {
    const corpus = getNameCorpus()
    const archetype = "acidhouse"
    const ancestor = "cypherpunk"
    const name = nameKDF(archetype, ancestor, "contemporary", "lsd", "air", "7", COLLECTION_SALT)

    // Extract the name part (before disambiguator)
    const namePart = name.replace(/-\d{4}$/, "")

    // The name part should contain at least one root from the correct partition
    const candidates = corpus[`${archetype}:${ancestor}`]
    expect(candidates).toBeDefined()
    expect(candidates.length).toBeGreaterThanOrEqual(10)

    // Verify the root is present somewhere in the name
    const rootFound = candidates.some((c) => namePart.includes(c.root))
    expect(rootFound, `Name "${namePart}" should contain a root from ${archetype}:${ancestor}`).toBe(true)
  })

  it("produces unique names across 100 sequential tokenIds", () => {
    const names = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const name = nameKDF("chicago_detroit", "yoruba_babalawo", "modern", "mdma", "earth", String(i), COLLECTION_SALT)
      names.add(name)
    }
    // All 100 should be unique
    expect(names.size).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// Task 18.2: Fallback / Edge Cases
// ---------------------------------------------------------------------------

describe("NameKDF Edge Cases", () => {
  it("returns fallback name for unknown archetype×ancestor pair", () => {
    const name = nameKDF("unknown_archetype", "unknown_ancestor", "ancient", "water", "fire", "1", COLLECTION_SALT)
    // Should use the Agent-XXXXXXXX fallback
    expect(name).toMatch(/^Agent-[0-9a-f]{8}$/)
  })

  it("handles empty tokenId gracefully", () => {
    const name = nameKDF("freetekno", "greek_philosopher", "ancient", "psilocybin", "fire", "", COLLECTION_SALT)
    expect(name).toBeTruthy()
    expect(name.length).toBeGreaterThan(0)
  })

  it("handles special characters in tokenId", () => {
    const name = nameKDF("freetekno", "greek_philosopher", "ancient", "psilocybin", "fire", "token-#42!", COLLECTION_SALT)
    expect(name).toBeTruthy()
  })
})
