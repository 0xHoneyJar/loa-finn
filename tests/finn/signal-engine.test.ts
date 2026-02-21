// tests/finn/signal-engine.test.ts — Signal Engine Tests (Sprint 1 Tasks 1.3 + 1.4)

import assert from "node:assert/strict"
import {
  deriveEra,
  deriveTarot,
  deriveElement,
  deriveArchetypeAffinity,
  resolveAncestorConnection,
  propagateIdentityChain,
  buildSignalSnapshot,
  projectSignals,
  resetSignalEngineCaches,
} from "../../src/nft/signal-engine.js"
import type { OnChainMetadata } from "../../src/nft/signal-engine.js"
import {
  loadMoleculeTarotBijection,
  clearArtifactCache,
  getRegisteredArtifacts,
  loadArtifact,
  loadAncestors,
} from "../../src/nft/codex-data/loader.js"
import type { Element } from "../../src/nft/signal-types.js"

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

async function main() {
  console.log("Signal Engine Tests (Sprint 1 Tasks 1.3 + 1.4)")
  console.log("================================================")

  // Reset caches before tests
  resetSignalEngineCaches()
  clearArtifactCache()

  // ===================================================================
  // Era Derivation
  // ===================================================================

  await test("deriveEra: ancient era for -500 BCE", () => {
    assert.equal(deriveEra("-500-01-01"), "ancient")
  })

  await test("deriveEra: ancient era for 499 CE", () => {
    assert.equal(deriveEra("0499-12-31"), "ancient")
  })

  await test("deriveEra: medieval era for 500 CE (boundary)", () => {
    assert.equal(deriveEra("0500-01-01"), "medieval")
  })

  await test("deriveEra: medieval era for 1352", () => {
    assert.equal(deriveEra("1352-06-15"), "medieval")
  })

  await test("deriveEra: early_modern for 1500 (boundary)", () => {
    assert.equal(deriveEra("1500-01-01"), "early_modern")
  })

  await test("deriveEra: early_modern for 1776", () => {
    assert.equal(deriveEra("1776-07-04"), "early_modern")
  })

  await test("deriveEra: modern for 1800 (boundary)", () => {
    assert.equal(deriveEra("1800-01-01"), "modern")
  })

  await test("deriveEra: modern for 1920", () => {
    assert.equal(deriveEra("1920-03-15"), "modern")
  })

  await test("deriveEra: contemporary for 1950 (boundary)", () => {
    assert.equal(deriveEra("1950-01-01"), "contemporary")
  })

  await test("deriveEra: contemporary for 2025", () => {
    assert.equal(deriveEra("2025-02-19"), "contemporary")
  })

  await test("deriveEra: ancient for very old date -10000", () => {
    assert.equal(deriveEra("-10000-01-01"), "ancient")
  })

  await test("deriveEra: ancient for date below boundary -13000", () => {
    // Below -13000 should still be ancient (fallback)
    assert.equal(deriveEra("-15000-01-01"), "ancient")
  })

  // ===================================================================
  // Element Derivation
  // ===================================================================

  await test("deriveElement: wands -> fire", () => {
    assert.equal(deriveElement("wands"), "fire")
  })

  await test("deriveElement: cups -> water", () => {
    assert.equal(deriveElement("cups"), "water")
  })

  await test("deriveElement: swords -> air", () => {
    assert.equal(deriveElement("swords"), "air")
  })

  await test("deriveElement: pentacles -> earth", () => {
    assert.equal(deriveElement("pentacles"), "earth")
  })

  await test("deriveElement: major -> fire", () => {
    assert.equal(deriveElement("major"), "fire")
  })

  // ===================================================================
  // Tarot Derivation (Bijection)
  // ===================================================================

  await test("deriveTarot: LSD maps to The Star (Major Arcana)", () => {
    const card = deriveTarot("LSD")
    assert.equal(card.name, "The Star")
    assert.equal(card.number, 17)
    assert.equal(card.suit, "major")
    assert.equal(card.element, "air")
  })

  await test("deriveTarot: Ayahuasca maps to The Fool (Major Arcana)", () => {
    const card = deriveTarot("Ayahuasca")
    assert.equal(card.name, "The Fool")
    assert.equal(card.number, 0)
    assert.equal(card.suit, "major")
  })

  await test("deriveTarot: Cocaine maps to Three of Wands", () => {
    const card = deriveTarot("Cocaine")
    assert.equal(card.name, "Three of Wands")
    assert.equal(card.suit, "wands")
    assert.equal(card.element, "fire")
  })

  await test("deriveTarot: Alcohol maps to King of Pentacles", () => {
    const card = deriveTarot("Alcohol")
    assert.equal(card.name, "King of Pentacles")
    assert.equal(card.suit, "pentacles")
    assert.equal(card.element, "earth")
  })

  await test("deriveTarot: Piracetam maps to Ace of Swords", () => {
    const card = deriveTarot("Piracetam")
    assert.equal(card.name, "Ace of Swords")
    assert.equal(card.suit, "swords")
    assert.equal(card.element, "air")
  })

  await test("deriveTarot: Ashwagandha maps to The Hermit (Major Arcana)", () => {
    const card = deriveTarot("Ashwagandha")
    assert.equal(card.name, "The Hermit")
    assert.equal(card.suit, "major")
    assert.equal(card.element, "earth")
  })

  await test("deriveTarot: case-insensitive lookup", () => {
    const card = deriveTarot("lsd")
    assert.equal(card.name, "The Star")
  })

  await test("deriveTarot: throws for unknown molecule", () => {
    assert.throws(
      () => deriveTarot("NonExistentSubstance"),
      /Molecule not found in bijection/,
    )
  })

  // ===================================================================
  // Bijection Integrity
  // ===================================================================

  await test("Bijection: exactly 78 molecules", () => {
    const entries = loadMoleculeTarotBijection()
    assert.equal(entries.length, 78)
  })

  await test("Bijection: all 78 molecules are unique", () => {
    const entries = loadMoleculeTarotBijection()
    const molecules = new Set(entries.map((e) => e.molecule.toLowerCase()))
    assert.equal(molecules.size, 78, `Found ${78 - molecules.size} duplicate molecules`)
  })

  await test("Bijection: all 78 cards are unique", () => {
    const entries = loadMoleculeTarotBijection()
    const cards = new Set(entries.map((e) => `${e.card.arcana}:${e.card.name}`))
    assert.equal(cards.size, 78, `Found ${78 - cards.size} duplicate cards`)
  })

  await test("Bijection: 22 Major Arcana + 56 Minor Arcana", () => {
    const entries = loadMoleculeTarotBijection()
    const major = entries.filter((e) => e.card.arcana === "major")
    const minor = entries.filter((e) => e.card.arcana === "minor")
    assert.equal(major.length, 22, `Expected 22 Major Arcana, got ${major.length}`)
    assert.equal(minor.length, 56, `Expected 56 Minor Arcana, got ${minor.length}`)
  })

  await test("Bijection: Minor Arcana suits are valid", () => {
    const entries = loadMoleculeTarotBijection()
    const minor = entries.filter((e) => e.card.arcana === "minor")
    const validSuits = new Set(["wands", "cups", "swords", "pentacles"])
    for (const entry of minor) {
      assert.ok(
        entry.card.suit && validSuits.has(entry.card.suit),
        `Invalid suit for ${entry.molecule}: ${entry.card.suit}`,
      )
    }
  })

  await test("Bijection: Major Arcana have no suit", () => {
    const entries = loadMoleculeTarotBijection()
    const major = entries.filter((e) => e.card.arcana === "major")
    for (const entry of major) {
      assert.ok(
        entry.card.suit === undefined || entry.card.suit === null,
        `Major Arcana ${entry.molecule} should not have a suit: ${entry.card.suit}`,
      )
    }
  })

  await test("Bijection: each Minor Arcana suit has 14 cards", () => {
    const entries = loadMoleculeTarotBijection()
    const minor = entries.filter((e) => e.card.arcana === "minor")
    const suitCounts = new Map<string, number>()
    for (const entry of minor) {
      const suit = entry.card.suit!
      suitCounts.set(suit, (suitCounts.get(suit) ?? 0) + 1)
    }
    for (const [suit, count] of suitCounts) {
      assert.equal(count, 14, `Suit ${suit} has ${count} cards, expected 14`)
    }
  })

  // ===================================================================
  // All 78 drug -> tarot -> element chains resolve
  // ===================================================================

  await test("All 78 molecules resolve through full deriveTarot chain", () => {
    const entries = loadMoleculeTarotBijection()
    for (const entry of entries) {
      const card = deriveTarot(entry.molecule)
      assert.ok(card.name, `Card for ${entry.molecule} has no name`)
      assert.ok(card.element, `Card for ${entry.molecule} has no element`)
      assert.ok(
        ["fire", "water", "air", "earth"].includes(card.element),
        `Invalid element for ${entry.molecule}: ${card.element}`,
      )
    }
  })

  // ===================================================================
  // Archetype Affinity
  // ===================================================================

  await test("deriveArchetypeAffinity: wands -> freetekno primary", () => {
    const affinity = deriveArchetypeAffinity("wands")
    assert.equal(affinity.primary.archetype, "freetekno")
    assert.ok(affinity.primary.weight > 0)
  })

  await test("deriveArchetypeAffinity: cups -> acidhouse primary", () => {
    const affinity = deriveArchetypeAffinity("cups")
    assert.equal(affinity.primary.archetype, "acidhouse")
  })

  await test("deriveArchetypeAffinity: swords -> milady primary", () => {
    const affinity = deriveArchetypeAffinity("swords")
    assert.equal(affinity.primary.archetype, "milady")
  })

  await test("deriveArchetypeAffinity: pentacles -> chicago_detroit primary", () => {
    const affinity = deriveArchetypeAffinity("pentacles")
    assert.equal(affinity.primary.archetype, "chicago_detroit")
  })

  await test("deriveArchetypeAffinity: weights sum to 1.0 for each suit", () => {
    const suits = ["wands", "cups", "swords", "pentacles", "major"]
    for (const suit of suits) {
      const a = deriveArchetypeAffinity(suit)
      const sum = a.primary.weight + a.secondary.weight + a.tertiary.weight + a.quaternary.weight
      assert.ok(
        Math.abs(sum - 1.0) < 0.001,
        `Weights for ${suit} sum to ${sum}, expected 1.0`,
      )
    }
  })

  // ===================================================================
  // Ancestor Connection
  // ===================================================================

  await test("resolveAncestorConnection: known ancestor", () => {
    const connection = resolveAncestorConnection("greek_philosopher")
    assert.ok(connection)
    assert.equal(connection.name, "Greek Philosopher")
    assert.ok(connection.keywords.length > 0)
  })

  await test("resolveAncestorConnection: unknown ancestor returns null", () => {
    const connection = resolveAncestorConnection("nonexistent_ancestor")
    assert.equal(connection, null)
  })

  await test("All 33 ancestors are resolvable", () => {
    const ancestors = loadAncestors()
    assert.equal(ancestors.length, 33)
    for (const a of ancestors) {
      const connection = resolveAncestorConnection(a.id)
      assert.ok(connection, `Failed to resolve ancestor: ${a.id}`)
    }
  })

  // ===================================================================
  // Nested Identity Propagation (Task 1.4)
  // ===================================================================

  await test("propagateIdentityChain: Ketamine -> Death -> major -> water -> archetype affinity", () => {
    const chain = propagateIdentityChain("Ketamine", "greek_philosopher")
    assert.equal(chain.molecule, "Ketamine")
    assert.equal(chain.tarot.name, "Death")
    assert.equal(chain.tarot.suit, "major")
    assert.equal(chain.element, "water")
    assert.ok(chain.archetype_affinity.primary)
    assert.ok(chain.ancestor_connection)
    assert.equal(chain.ancestor_connection!.id, "greek_philosopher")
  })

  await test("propagateIdentityChain: Cocaine -> Three of Wands -> wands -> fire -> freetekno", () => {
    const chain = propagateIdentityChain("Cocaine", "cypherpunk")
    assert.equal(chain.tarot.name, "Three of Wands")
    assert.equal(chain.tarot.suit, "wands")
    assert.equal(chain.element, "fire")
    assert.equal(chain.archetype_affinity.primary.archetype, "freetekno")
    assert.ok(chain.ancestor_connection)
    assert.equal(chain.ancestor_connection!.id, "cypherpunk")
  })

  await test("propagateIdentityChain: Alcohol -> King of Pentacles -> pentacles -> earth -> chicago_detroit", () => {
    const chain = propagateIdentityChain("Alcohol", "beat_poet")
    assert.equal(chain.tarot.suit, "pentacles")
    assert.equal(chain.element, "earth")
    assert.equal(chain.archetype_affinity.primary.archetype, "chicago_detroit")
  })

  await test("propagateIdentityChain: Piracetam -> Ace of Swords -> swords -> air -> milady", () => {
    const chain = propagateIdentityChain("Piracetam", "german_idealist")
    assert.equal(chain.tarot.suit, "swords")
    assert.equal(chain.element, "air")
    assert.equal(chain.archetype_affinity.primary.archetype, "milady")
  })

  await test("propagateIdentityChain: Ashwagandha -> The Hermit -> major -> earth -> acidhouse", () => {
    const chain = propagateIdentityChain("Ashwagandha", "aboriginal_elder")
    assert.equal(chain.tarot.suit, "major")
    assert.equal(chain.element, "earth")
    assert.equal(chain.archetype_affinity.primary.archetype, "acidhouse")
  })

  await test("propagateIdentityChain: deterministic — same input always same output", () => {
    const chain1 = propagateIdentityChain("LSD", "zen_master")
    const chain2 = propagateIdentityChain("LSD", "zen_master")
    assert.deepEqual(chain1, chain2)
  })

  await test("propagateIdentityChain: all 78 molecules resolve without error", () => {
    const entries = loadMoleculeTarotBijection()
    for (const entry of entries) {
      // Should not throw
      const chain = propagateIdentityChain(entry.molecule, "greek_philosopher")
      assert.ok(chain.tarot)
      assert.ok(chain.element)
      assert.ok(chain.archetype_affinity)
    }
  })

  // ===================================================================
  // buildSignalSnapshot
  // ===================================================================

  await test("buildSignalSnapshot: produces valid SignalSnapshot from metadata", () => {
    const metadata: OnChainMetadata = {
      archetype: "milady",
      ancestor: "sufi_mystic",
      birthday: "1352-06-15",
      molecule: "LSD",
      swag_rank: "S",
      swag_score: 75,
      sun_sign: "aries",
      moon_sign: "pisces",
      ascending_sign: "leo",
    }
    const snapshot = buildSignalSnapshot(metadata)

    assert.equal(snapshot.archetype, "milady")
    assert.equal(snapshot.ancestor, "sufi_mystic")
    assert.equal(snapshot.birthday, "1352-06-15")
    assert.equal(snapshot.era, "medieval")
    assert.equal(snapshot.molecule, "LSD")
    assert.equal(snapshot.tarot.name, "The Star")
    assert.equal(snapshot.tarot.suit, "major")
    assert.equal(snapshot.element, "air")
    assert.equal(snapshot.swag_rank, "S")
    assert.equal(snapshot.swag_score, 75)
    assert.equal(snapshot.sun_sign, "aries")
    assert.equal(snapshot.moon_sign, "pisces")
    assert.equal(snapshot.ascending_sign, "leo")
  })

  await test("buildSignalSnapshot: deterministic — same input always same output", () => {
    const metadata: OnChainMetadata = {
      archetype: "freetekno",
      ancestor: "cypherpunk",
      birthday: "2000-01-01",
      molecule: "Weed",
      swag_rank: "A",
      swag_score: 50,
      sun_sign: "capricorn",
      moon_sign: "cancer",
      ascending_sign: "virgo",
    }
    const s1 = buildSignalSnapshot(metadata)
    const s2 = buildSignalSnapshot(metadata)
    assert.deepEqual(s1, s2)
  })

  // ===================================================================
  // projectSignals
  // ===================================================================

  await test("projectSignals: produces valid SignalCore8", () => {
    const metadata: OnChainMetadata = {
      archetype: "acidhouse",
      ancestor: "buddhist_monk",
      birthday: "1990-05-15",
      molecule: "MDMA",
      swag_rank: "SS",
      swag_score: 80,
      sun_sign: "taurus",
      moon_sign: "scorpio",
      ascending_sign: "aquarius",
    }
    const snapshot = buildSignalSnapshot(metadata)
    const core = projectSignals(snapshot)

    assert.equal(core.value_system, "acidhouse")
    assert.equal(core.cultural_frame, "buddhist_monk")
    assert.equal(core.temporal_constraint, "contemporary")
    assert.ok(core.consciousness_orientation >= 0 && core.consciousness_orientation <= 1)
    assert.equal(core.energy_style, snapshot.element)
    assert.ok(core.presence_modifier >= 0 && core.presence_modifier <= 1)
    assert.ok(core.emotional_coloring >= 0 && core.emotional_coloring <= 1)
    assert.equal(core.task_override, "default")
  })

  await test("projectSignals: mode override", () => {
    const metadata: OnChainMetadata = {
      archetype: "milady",
      ancestor: "alchemist",
      birthday: "1600-01-01",
      molecule: "DMT",
      swag_rank: "SSS",
      swag_score: 100,
      sun_sign: "scorpio",
      moon_sign: "pisces",
      ascending_sign: "cancer",
    }
    const snapshot = buildSignalSnapshot(metadata)
    const core = projectSignals(snapshot, "brainstorm")
    assert.equal(core.task_override, "brainstorm")
  })

  await test("projectSignals: deterministic — same input always same output", () => {
    const metadata: OnChainMetadata = {
      archetype: "chicago_detroit",
      ancestor: "yoruba_babalawo",
      birthday: "1850-12-25",
      molecule: "Caffeine",
      swag_rank: "B",
      swag_score: 40,
      sun_sign: "leo",
      moon_sign: "gemini",
      ascending_sign: "sagittarius",
    }
    const snapshot = buildSignalSnapshot(metadata)
    const c1 = projectSignals(snapshot)
    const c2 = projectSignals(snapshot)
    assert.deepEqual(c1, c2)
  })

  await test("projectSignals: presence_modifier combines rank and score", () => {
    const metadata: OnChainMetadata = {
      archetype: "freetekno",
      ancestor: "cypherpunk",
      birthday: "2000-01-01",
      molecule: "LSD",
      swag_rank: "SSS",
      swag_score: 100,
      sun_sign: "aries",
      moon_sign: "aries",
      ascending_sign: "aries",
    }
    const snapshot = buildSignalSnapshot(metadata)
    const core = projectSignals(snapshot)
    // SSS = 1.0, score = 100/100 = 1.0
    // presence = 1.0 * 0.6 + 1.0 * 0.4 = 1.0
    assert.ok(Math.abs(core.presence_modifier - 1.0) < 0.001)
  })

  // ===================================================================
  // Codex Data Loader Tests
  // ===================================================================

  await test("Codex loader: all default artifacts are registered", () => {
    const names = getRegisteredArtifacts()
    const expected = [
      "molecule-tarot-bijection",
      "ancestors",
      "archetype-definitions",
      "archetype-affinity",
      "codex-version",
    ]
    for (const name of expected) {
      assert.ok(names.includes(name), `Missing registered artifact: ${name}`)
    }
  })

  await test("Codex loader: all registered artifacts load with valid checksums", () => {
    const names = getRegisteredArtifacts()
    for (const name of names) {
      const artifact = loadArtifact(name)
      assert.ok(artifact.data, `Artifact ${name} has no data`)
      assert.ok(artifact.valid, `Artifact ${name} failed checksum validation (checksum: ${artifact.checksum})`)
    }
  })

  console.log("\nAll signal-engine tests complete.")
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
