// tests/finn/signal-types.test.ts — Signal & Identity Type Tests (Sprint 1 Task 1.2)

import assert from "node:assert/strict"
import type {
  Archetype,
  Era,
  Element,
  SwagRank,
  ZodiacSign,
  AgentMode,
  TarotCard,
  SignalSnapshot,
  SignalCore8,
  DAPMDialId,
  DAPMFingerprint,
  DerivedVoiceProfile,
  PersonalityVersion,
  CompatibilityMode,
} from "../../src/nft/signal-types.js"
import {
  ARCHETYPES,
  ERA_BOUNDARIES,
  SWAG_RANK_VALUES,
  ZODIAC_SIGNS,
  DAPM_DIAL_IDS,
} from "../../src/nft/signal-types.js"

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
  console.log("Signal & Identity Type Tests (Sprint 1 Task 1.2)")
  console.log("==================================================")

  // --- Archetypes ---

  await test("ARCHETYPES has exactly 4 entries", () => {
    assert.equal(ARCHETYPES.length, 4)
  })

  await test("ARCHETYPES contains all expected values", () => {
    const expected: Archetype[] = ["freetekno", "milady", "chicago_detroit", "acidhouse"]
    for (const a of expected) {
      assert.ok(ARCHETYPES.includes(a), `Missing archetype: ${a}`)
    }
  })

  // --- Era Boundaries ---

  await test("ERA_BOUNDARIES covers all 5 eras", () => {
    const eras: Era[] = ["ancient", "medieval", "early_modern", "modern", "contemporary"]
    for (const era of eras) {
      assert.ok(ERA_BOUNDARIES[era], `Missing era boundary: ${era}`)
    }
  })

  await test("ERA_BOUNDARIES are contiguous (no gaps)", () => {
    const ordered: Era[] = ["ancient", "medieval", "early_modern", "modern", "contemporary"]
    for (let i = 0; i < ordered.length - 1; i++) {
      const current = ERA_BOUNDARIES[ordered[i]]
      const next = ERA_BOUNDARIES[ordered[i + 1]]
      assert.equal(current.end, next.start, `Gap between ${ordered[i]} and ${ordered[i + 1]}`)
    }
  })

  await test("ERA_BOUNDARIES ancient starts at -13000", () => {
    assert.equal(ERA_BOUNDARIES.ancient.start, -13000)
  })

  await test("ERA_BOUNDARIES contemporary ends at 9999", () => {
    assert.equal(ERA_BOUNDARIES.contemporary.end, 9999)
  })

  // --- SwagRank ---

  await test("SWAG_RANK_VALUES has exactly 8 ranks", () => {
    const ranks: SwagRank[] = ["SSS", "SS", "S", "A", "B", "C", "D", "F"]
    assert.equal(Object.keys(SWAG_RANK_VALUES).length, 8)
    for (const rank of ranks) {
      assert.ok(rank in SWAG_RANK_VALUES, `Missing rank: ${rank}`)
    }
  })

  await test("SWAG_RANK_VALUES range from 0.125 to 1.0", () => {
    assert.equal(SWAG_RANK_VALUES.SSS, 1.0)
    assert.equal(SWAG_RANK_VALUES.F, 0.125)
  })

  await test("SWAG_RANK_VALUES are monotonically decreasing", () => {
    const ranks: SwagRank[] = ["SSS", "SS", "S", "A", "B", "C", "D", "F"]
    for (let i = 0; i < ranks.length - 1; i++) {
      assert.ok(
        SWAG_RANK_VALUES[ranks[i]] > SWAG_RANK_VALUES[ranks[i + 1]],
        `${ranks[i]} (${SWAG_RANK_VALUES[ranks[i]]}) should be > ${ranks[i + 1]} (${SWAG_RANK_VALUES[ranks[i + 1]]})`,
      )
    }
  })

  // --- Zodiac Signs ---

  await test("ZODIAC_SIGNS has exactly 12 entries", () => {
    assert.equal(ZODIAC_SIGNS.length, 12)
  })

  await test("ZODIAC_SIGNS contains all 12 signs", () => {
    const expected: ZodiacSign[] = [
      "aries", "taurus", "gemini", "cancer",
      "leo", "virgo", "libra", "scorpio",
      "sagittarius", "capricorn", "aquarius", "pisces",
    ]
    for (const sign of expected) {
      assert.ok(ZODIAC_SIGNS.includes(sign), `Missing zodiac sign: ${sign}`)
    }
  })

  // --- DAPMDialId ---

  await test("DAPM_DIAL_IDS has exactly 96 entries", () => {
    assert.equal(DAPM_DIAL_IDS.length, 96)
  })

  await test("DAPM_DIAL_IDS has no duplicates", () => {
    const set = new Set(DAPM_DIAL_IDS)
    assert.equal(set.size, 96, `Found ${96 - set.size} duplicate dial IDs`)
  })

  await test("DAPM_DIAL_IDS covers all 12 categories", () => {
    const prefixes = new Set(DAPM_DIAL_IDS.map((id) => id.split("_")[0]))
    const expected = ["sw", "cs", "as", "cg", "ep", "cr", "cv", "mo", "et", "sc", "ag", "id"]
    assert.equal(prefixes.size, expected.length)
    for (const prefix of expected) {
      assert.ok(prefixes.has(prefix), `Missing category prefix: ${prefix}`)
    }
  })

  await test("Each DAPM category has exactly 8 dials", () => {
    const categories = new Map<string, number>()
    for (const id of DAPM_DIAL_IDS) {
      const prefix = id.split("_")[0]
      categories.set(prefix, (categories.get(prefix) ?? 0) + 1)
    }
    for (const [prefix, count] of categories) {
      assert.equal(count, 8, `Category ${prefix} has ${count} dials, expected 8`)
    }
  })

  // --- Type Compilation Checks ---

  await test("SignalSnapshot type compiles with all 12 fields", () => {
    const snapshot: SignalSnapshot = {
      archetype: "freetekno",
      ancestor: "greek_philosopher",
      birthday: "1352-06-15",
      era: "medieval",
      molecule: "LSD",
      tarot: { name: "The Magician", number: 1, suit: "major", element: "fire" },
      element: "fire",
      swag_rank: "S",
      swag_score: 75,
      sun_sign: "aries",
      moon_sign: "pisces",
      ascending_sign: "leo",
    }
    assert.ok(snapshot)
    assert.equal(snapshot.archetype, "freetekno")
  })

  await test("SignalCore8 type compiles with all 8 dimensions", () => {
    const core: SignalCore8 = {
      value_system: "milady",
      cultural_frame: "greek_philosopher",
      temporal_constraint: "ancient",
      consciousness_orientation: 0.5,
      energy_style: "air",
      presence_modifier: 0.75,
      emotional_coloring: 0.3,
      task_override: "default",
    }
    assert.ok(core)
    assert.equal(core.value_system, "milady")
  })

  await test("DAPMFingerprint type compiles correctly", () => {
    const dials = {} as Record<DAPMDialId, number>
    for (const id of DAPM_DIAL_IDS) {
      dials[id] = 0.5
    }
    const fp: DAPMFingerprint = {
      dials,
      mode: "default",
      derived_from: "version-123",
      derived_at: Date.now(),
    }
    assert.ok(fp)
    assert.equal(fp.mode, "default")
  })

  await test("DerivedVoiceProfile type compiles correctly", () => {
    const voice: DerivedVoiceProfile = {
      archetype_voice: "acidhouse",
      cultural_voice: "buddhist_monk",
      temporal_register: "contemporary",
      energy_signature: "water",
      confidence: 0.8,
    }
    assert.ok(voice)
    assert.equal(voice.archetype_voice, "acidhouse")
  })

  await test("PersonalityVersion type compiles correctly", () => {
    const version: PersonalityVersion = {
      version_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      previous_version_id: null,
      personality_id: "collection:token1",
      signal_snapshot: null,
      dapm_fingerprint: null,
      beauvoir_md: "# Test",
      authored_by: "0x1234",
      governance_model: "holder",
      codex_version: "placeholder",
      compatibility_mode: "legacy_v1",
      created_at: Date.now(),
      change_summary: "Initial version",
    }
    assert.ok(version)
    assert.equal(version.compatibility_mode, "legacy_v1")
  })

  await test("CompatibilityMode type accepts valid values", () => {
    const legacy: CompatibilityMode = "legacy_v1"
    const signal: CompatibilityMode = "signal_v2"
    assert.equal(legacy, "legacy_v1")
    assert.equal(signal, "signal_v2")
  })

  await test("TarotCard type compiles for Major Arcana", () => {
    const card: TarotCard = {
      name: "The Fool",
      number: 0,
      suit: "major",
      element: "fire",
    }
    assert.ok(card)
    assert.equal(card.suit, "major")
  })

  await test("TarotCard type compiles for Minor Arcana", () => {
    const card: TarotCard = {
      name: "Ace of Wands",
      number: 1,
      suit: "wands",
      element: "fire",
    }
    assert.ok(card)
    assert.equal(card.suit, "wands")
  })

  console.log("\nAll signal-types tests complete.")
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
