// tests/finn/damp.test.ts — dAMP-96 Derivation Test Suite (Sprint 7 Task 7.6)

import { describe, it, expect, beforeEach } from "vitest"
import * as fc from "fast-check"
import {
  deriveDAMP,
  resolveAncestorFamily,
  normalizeSwag,
  deriveAstrologyBlend,
  ANCESTOR_TO_FAMILY,
  ANCESTOR_FAMILIES,
} from "../../src/nft/damp.js"
import type { AncestorFamily } from "../../src/nft/damp.js"
import {
  getDAMPTables,
  resetDAMPTablesCache,
} from "../../src/nft/damp-tables.js"
import { clearArtifactCache, loadArtifact } from "../../src/nft/codex-data/loader.js"
import { computeSha256 } from "../../src/nft/codex-data/checksums.js"
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DAMP_DIAL_IDS,
  SWAG_RANK_VALUES,
  ZODIAC_SIGNS,
  ARCHETYPES,
} from "../../src/nft/signal-types.js"
import type {
  SignalSnapshot,
  AgentMode,
  DAMPDialId,
  SwagRank,
  ZodiacSign,
  Archetype,
  Element,
  Era,
} from "../../src/nft/signal-types.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const CODEX_DATA_DIR = resolve(__dirname, "../../src/nft/codex-data")

function makeSnapshot(overrides?: Partial<SignalSnapshot>): SignalSnapshot {
  return {
    archetype: "freetekno",
    ancestor: "greek_philosopher",
    birthday: "0450-01-15",
    era: "ancient",
    molecule: "psilocybin",
    tarot: { name: "The Fool", number: 0, suit: "major", element: "air" },
    element: "fire",
    swag_rank: "A",
    swag_score: 75,
    sun_sign: "aries",
    moon_sign: "cancer",
    ascending_sign: "libra",
    ...overrides,
  }
}

// fast-check arbitraries
const arbArchetype = fc.constantFrom<Archetype>("freetekno", "milady", "chicago_detroit", "acidhouse")
const arbEra = fc.constantFrom<Era>("ancient", "medieval", "early_modern", "modern", "contemporary")
const arbElement = fc.constantFrom<Element>("fire", "water", "air", "earth")
const arbSwagRank = fc.constantFrom<SwagRank>("SSS", "SS", "S", "A", "B", "C", "D", "F")
const arbZodiac = fc.constantFrom<ZodiacSign>(
  "aries", "taurus", "gemini", "cancer", "leo", "virgo",
  "libra", "scorpio", "sagittarius", "capricorn", "aquarius", "pisces",
)
const arbAncestor = fc.constantFrom(...Object.keys(ANCESTOR_TO_FAMILY))
const arbMode = fc.constantFrom<AgentMode>("default", "brainstorm", "critique", "execute")

const arbSnapshot: fc.Arbitrary<SignalSnapshot> = fc.record({
  archetype: arbArchetype,
  ancestor: arbAncestor,
  birthday: fc.constant("1352-06-15"),
  era: arbEra,
  molecule: fc.constant("psilocybin"),
  tarot: fc.constant({ name: "The Fool", number: 0, suit: "major" as const, element: "air" as const }),
  element: arbElement,
  swag_rank: arbSwagRank,
  swag_score: fc.integer({ min: 0, max: 100 }),
  sun_sign: arbZodiac,
  moon_sign: arbZodiac,
  ascending_sign: arbZodiac,
})

// ---------------------------------------------------------------------------
// Table Completeness & Integrity
// ---------------------------------------------------------------------------

describe("dAMP Tables (Task 7.2)", () => {
  beforeEach(() => {
    clearArtifactCache()
    resetDAMPTablesCache()
  })

  it("loads damp-tables.json without error", () => {
    const tables = getDAMPTables()
    expect(tables).toBeDefined()
    expect(tables.archetype_offsets).toBeDefined()
    expect(tables.ancestor_family_offsets).toBeDefined()
    expect(tables.era_offsets).toBeDefined()
    expect(tables.element_offsets).toBeDefined()
    expect(tables.tarot_suit_scales).toBeDefined()
    expect(tables.swag_dial_scales).toBeDefined()
    expect(tables.astrology_dial_offsets).toBeDefined()
    expect(tables.mode_deltas).toBeDefined()
  })

  it("archetype_offsets has all 4 archetypes × 96 dials", () => {
    const tables = getDAMPTables()
    for (const arch of ["freetekno", "milady", "chicago_detroit", "acidhouse"]) {
      const row = tables.archetype_offsets[arch]
      expect(row, `missing archetype: ${arch}`).toBeDefined()
      expect(Object.keys(row).length).toBe(96)
      for (const dialId of DAMP_DIAL_IDS) {
        expect(typeof row[dialId]).toBe("number")
      }
    }
  })

  it("ancestor_family_offsets has all 8 families × 96 dials", () => {
    const tables = getDAMPTables()
    for (const family of ANCESTOR_FAMILIES) {
      const row = tables.ancestor_family_offsets[family]
      expect(row, `missing family: ${family}`).toBeDefined()
      expect(Object.keys(row).length).toBe(96)
    }
  })

  it("era_offsets has all 5 eras × 96 dials", () => {
    const tables = getDAMPTables()
    for (const era of ["ancient", "medieval", "early_modern", "modern", "contemporary"]) {
      const row = tables.era_offsets[era]
      expect(row, `missing era: ${era}`).toBeDefined()
      expect(Object.keys(row).length).toBe(96)
    }
  })

  it("element_offsets has all 4 elements × 96 dials", () => {
    const tables = getDAMPTables()
    for (const elem of ["fire", "water", "air", "earth"]) {
      const row = tables.element_offsets[elem]
      expect(row, `missing element: ${elem}`).toBeDefined()
      expect(Object.keys(row).length).toBe(96)
    }
  })

  it("tarot_suit_scales has all 5 suits × 96 dials", () => {
    const tables = getDAMPTables()
    for (const suit of ["wands", "cups", "swords", "pentacles", "major"]) {
      const row = tables.tarot_suit_scales[suit]
      expect(row, `missing suit: ${suit}`).toBeDefined()
      expect(Object.keys(row).length).toBe(96)
    }
  })

  it("swag_dial_scales has all 96 dials", () => {
    const tables = getDAMPTables()
    expect(Object.keys(tables.swag_dial_scales).length).toBe(96)
  })

  it("astrology_dial_offsets has all 96 dials", () => {
    const tables = getDAMPTables()
    expect(Object.keys(tables.astrology_dial_offsets).length).toBe(96)
  })

  it("mode_deltas has all 4 modes", () => {
    const tables = getDAMPTables()
    for (const mode of ["brainstorm", "critique", "execute", "default"]) {
      expect(tables.mode_deltas[mode]).toBeDefined()
    }
  })

  it("all offset values are within [-0.5, +0.5] range", () => {
    const tables = getDAMPTables()
    const checkRange = (obj: Record<string, unknown>, path: string) => {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "number") {
          expect(v, `${path}.${k} = ${v}`).toBeGreaterThanOrEqual(-0.5)
          expect(v, `${path}.${k} = ${v}`).toBeLessThanOrEqual(0.5)
        } else if (v && typeof v === "object") {
          checkRange(v as Record<string, unknown>, `${path}.${k}`)
        }
      }
    }
    checkRange(tables as unknown as Record<string, unknown>, "tables")
  })

  it("checksum of damp-tables.json matches .sha256 file", () => {
    const jsonPath = resolve(CODEX_DATA_DIR, "damp-tables.json")
    const sha256Path = resolve(CODEX_DATA_DIR, "damp-tables.json.sha256")
    const expectedHash = readFileSync(sha256Path, "utf-8").trim().toLowerCase()
    const actualHash = computeSha256(jsonPath)
    expect(actualHash).toBe(expectedHash)
  })

  it("codex loader validates damp-tables artifact", () => {
    const artifact = loadArtifact("damp-tables")
    expect(artifact.valid).toBe(true)
    expect(artifact.data).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Composition Function (Task 7.1)
// ---------------------------------------------------------------------------

describe("deriveDAMP (Task 7.1)", () => {
  beforeEach(() => {
    clearArtifactCache()
    resetDAMPTablesCache()
  })

  it("returns all 96 dials", () => {
    const fp = deriveDAMP(makeSnapshot(), "default")
    expect(Object.keys(fp.dials).length).toBe(96)
    for (const dialId of DAMP_DIAL_IDS) {
      expect(typeof fp.dials[dialId]).toBe("number")
    }
  })

  it("all dials in [0.0, 1.0] for a basic snapshot", () => {
    const fp = deriveDAMP(makeSnapshot(), "default")
    for (const dialId of DAMP_DIAL_IDS) {
      const val = fp.dials[dialId]
      expect(val, `${dialId} = ${val}`).toBeGreaterThanOrEqual(0.0)
      expect(val, `${dialId} = ${val}`).toBeLessThanOrEqual(1.0)
    }
  })

  it("is deterministic: same inputs produce same dials", () => {
    const snap = makeSnapshot()
    const fp1 = deriveDAMP(snap, "default")
    const fp2 = deriveDAMP(snap, "default")
    for (const dialId of DAMP_DIAL_IDS) {
      expect(fp1.dials[dialId]).toBe(fp2.dials[dialId])
    }
  })

  it("populates mode and derived_from fields", () => {
    const fp = deriveDAMP(makeSnapshot(), "brainstorm")
    expect(fp.mode).toBe("brainstorm")
    expect(typeof fp.derived_from).toBe("string")
    expect(fp.derived_from.length).toBeGreaterThan(0)
    expect(typeof fp.derived_at).toBe("number")
  })

  it("different archetypes produce different fingerprints (>= 10 dials differ)", () => {
    const archetypes: Archetype[] = ["freetekno", "milady", "chicago_detroit", "acidhouse"]
    for (let i = 0; i < archetypes.length; i++) {
      for (let j = i + 1; j < archetypes.length; j++) {
        const fp1 = deriveDAMP(makeSnapshot({ archetype: archetypes[i] }), "default")
        const fp2 = deriveDAMP(makeSnapshot({ archetype: archetypes[j] }), "default")
        let differCount = 0
        for (const dialId of DAMP_DIAL_IDS) {
          if (Math.abs(fp1.dials[dialId] - fp2.dials[dialId]) > 0.001) {
            differCount++
          }
        }
        expect(
          differCount,
          `${archetypes[i]} vs ${archetypes[j]}: only ${differCount} dials differ`,
        ).toBeGreaterThanOrEqual(10)
      }
    }
  })

  it("different modes produce different fingerprints", () => {
    const snap = makeSnapshot()
    const fpDefault = deriveDAMP(snap, "default")
    const fpBrainstorm = deriveDAMP(snap, "brainstorm")
    const fpCritique = deriveDAMP(snap, "critique")
    const fpExecute = deriveDAMP(snap, "execute")

    // brainstorm should differ from default on creativity dials
    let brainstormDiff = 0
    for (const dialId of DAMP_DIAL_IDS) {
      if (Math.abs(fpDefault.dials[dialId] - fpBrainstorm.dials[dialId]) > 0.001) {
        brainstormDiff++
      }
    }
    expect(brainstormDiff).toBeGreaterThan(0)

    // critique should differ from default
    let critiqueDiff = 0
    for (const dialId of DAMP_DIAL_IDS) {
      if (Math.abs(fpDefault.dials[dialId] - fpCritique.dials[dialId]) > 0.001) {
        critiqueDiff++
      }
    }
    expect(critiqueDiff).toBeGreaterThan(0)

    // execute should differ from default
    let executeDiff = 0
    for (const dialId of DAMP_DIAL_IDS) {
      if (Math.abs(fpDefault.dials[dialId] - fpExecute.dials[dialId]) > 0.001) {
        executeDiff++
      }
    }
    expect(executeDiff).toBeGreaterThan(0)
  })

  // Property-based tests
  it("property: all dials in [0.0, 1.0] for random inputs", () => {
    fc.assert(
      fc.property(arbSnapshot, arbMode, (snap, mode) => {
        const fp = deriveDAMP(snap, mode)
        for (const dialId of DAMP_DIAL_IDS) {
          const val = fp.dials[dialId]
          if (val < 0.0 || val > 1.0) {
            return false
          }
        }
        return true
      }),
      { numRuns: 100 },
    )
  })

  it("property: deterministic for same input", () => {
    fc.assert(
      fc.property(arbSnapshot, arbMode, (snap, mode) => {
        const fp1 = deriveDAMP(snap, mode)
        const fp2 = deriveDAMP(snap, mode)
        for (const dialId of DAMP_DIAL_IDS) {
          if (fp1.dials[dialId] !== fp2.dials[dialId]) return false
        }
        return true
      }),
      { numRuns: 50 },
    )
  })
})

// ---------------------------------------------------------------------------
// Ancestor Family Resolution (Task 7.3)
// ---------------------------------------------------------------------------

describe("resolveAncestorFamily (Task 7.3)", () => {
  it("maps all 33 ancestors to valid families", () => {
    const ancestors = Object.keys(ANCESTOR_TO_FAMILY)
    expect(ancestors.length).toBe(33)
    for (const ancestor of ancestors) {
      const family = resolveAncestorFamily(ancestor)
      expect(ANCESTOR_FAMILIES).toContain(family)
    }
  })

  it("unknown ancestor defaults to mystical", () => {
    expect(resolveAncestorFamily("nonexistent_ancestor")).toBe("mystical")
    expect(resolveAncestorFamily("")).toBe("mystical")
  })

  it("known ancestor with graph still uses table lookup (Sprint 9)", () => {
    // With Sprint 9, resolveAncestorFamily does table lookup first, then graph fallback.
    // Known ancestors always resolve via table even when a graph is provided.
    const fakeGraph = { nodes: new Map(), edges: [], adjacency: new Map() }
    expect(resolveAncestorFamily("greek_philosopher", fakeGraph as any)).toBe("hellenic")
  })

  it("null graph uses table lookup", () => {
    expect(resolveAncestorFamily("greek_philosopher", null)).toBe("hellenic")
    expect(resolveAncestorFamily("buddhist_monk", null)).toBe("dharmic")
    expect(resolveAncestorFamily("cypherpunk", null)).toBe("techno_modern")
  })

  it("covers all 8 families", () => {
    const families = new Set<AncestorFamily>()
    for (const ancestor of Object.keys(ANCESTOR_TO_FAMILY)) {
      families.add(resolveAncestorFamily(ancestor))
    }
    expect(families.size).toBe(8)
    for (const f of ANCESTOR_FAMILIES) {
      expect(families.has(f), `missing family: ${f}`).toBe(true)
    }
  })

  it("specific ancestor-family mappings are correct", () => {
    expect(resolveAncestorFamily("celtic_druid")).toBe("celtic_norse")
    expect(resolveAncestorFamily("norse_skald")).toBe("celtic_norse")
    expect(resolveAncestorFamily("taoist_sage")).toBe("east_asian")
    expect(resolveAncestorFamily("yoruba_babalawo")).toBe("african_diasporic")
    expect(resolveAncestorFamily("aboriginal_elder")).toBe("indigenous")
    expect(resolveAncestorFamily("sufi_mystic")).toBe("mystical")
    expect(resolveAncestorFamily("vedic_rishi")).toBe("dharmic")
    expect(resolveAncestorFamily("stoic_philosopher")).toBe("hellenic")
  })
})

// ---------------------------------------------------------------------------
// Swag Normalization (Task 7.4)
// ---------------------------------------------------------------------------

describe("normalizeSwag (Task 7.4)", () => {
  it("SSS rank with score 100 gives 1.0", () => {
    expect(normalizeSwag("SSS", 100)).toBeCloseTo(1.0)
  })

  it("F rank with score 0 gives lowest value", () => {
    const result = normalizeSwag("F", 0)
    expect(result).toBeCloseTo(0.7 * 0.125 + 0.3 * 0)
    expect(result).toBeGreaterThanOrEqual(0)
    expect(result).toBeLessThanOrEqual(1)
  })

  it("formula: 0.7 * rank_value + 0.3 * (score/100)", () => {
    const ranks: SwagRank[] = ["SSS", "SS", "S", "A", "B", "C", "D", "F"]
    for (const rank of ranks) {
      for (const score of [0, 25, 50, 75, 100]) {
        const expected = 0.7 * SWAG_RANK_VALUES[rank] + 0.3 * (score / 100)
        expect(normalizeSwag(rank, score)).toBeCloseTo(expected)
      }
    }
  })

  it("result always in [0, 1]", () => {
    fc.assert(
      fc.property(arbSwagRank, fc.integer({ min: 0, max: 100 }), (rank, score) => {
        const result = normalizeSwag(rank, score)
        return result >= 0 && result <= 1
      }),
      { numRuns: 200 },
    )
  })

  it("B rank with score 50 gives 0.5", () => {
    // 0.7 * 0.50 + 0.3 * 0.50 = 0.35 + 0.15 = 0.50
    expect(normalizeSwag("B", 50)).toBeCloseTo(0.5)
  })

  it("higher rank always gives higher result for same score", () => {
    const ordered: SwagRank[] = ["F", "D", "C", "B", "A", "S", "SS", "SSS"]
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(normalizeSwag(ordered[i], 50)).toBeLessThan(normalizeSwag(ordered[i + 1], 50))
    }
  })
})

// ---------------------------------------------------------------------------
// Astrology Blending (Task 7.5)
// ---------------------------------------------------------------------------

describe("deriveAstrologyBlend (Task 7.5)", () => {
  it("Aries/Aries/Aries gives 0", () => {
    expect(deriveAstrologyBlend("aries", "aries", "aries")).toBeCloseTo(0.0)
  })

  it("Pisces/Pisces/Pisces gives 1.0", () => {
    // (0.5 * 11/11) + (0.3 * 11/11) + (0.2 * 11/11) = 1.0
    expect(deriveAstrologyBlend("pisces", "pisces", "pisces")).toBeCloseTo(1.0)
  })

  it("sun has weight 0.5, moon 0.3, rising 0.2", () => {
    // Leo=4, ordinal = 4/11
    // sun only: 0.5 * (4/11) = 0.5 * 0.3636... ≈ 0.1818
    const sunOnly = deriveAstrologyBlend("leo", "aries", "aries")
    expect(sunOnly).toBeCloseTo(0.5 * (4 / 11))

    // moon only: 0.3 * (4/11)
    const moonOnly = deriveAstrologyBlend("aries", "leo", "aries")
    expect(moonOnly).toBeCloseTo(0.3 * (4 / 11))

    // rising only: 0.2 * (4/11)
    const risingOnly = deriveAstrologyBlend("aries", "aries", "leo")
    expect(risingOnly).toBeCloseTo(0.2 * (4 / 11))
  })

  it("result always in [0, 1]", () => {
    fc.assert(
      fc.property(arbZodiac, arbZodiac, arbZodiac, (sun, moon, rising) => {
        const result = deriveAstrologyBlend(sun, moon, rising)
        return result >= 0 && result <= 1
      }),
      { numRuns: 200 },
    )
  })

  it("all 12 signs produce different results as sun sign", () => {
    const values = new Set<number>()
    for (const sign of ZODIAC_SIGNS) {
      values.add(Math.round(deriveAstrologyBlend(sign, "aries", "aries") * 10000))
    }
    expect(values.size).toBe(12)
  })

  it("specific computation: Aries sun, Cancer moon, Libra rising", () => {
    // Aries=0, Cancer=3, Libra=6
    // 0.5*(0/11) + 0.3*(3/11) + 0.2*(6/11) = 0 + 0.08181... + 0.10909... = 0.19090...
    const expected = 0.5 * (0 / 11) + 0.3 * (3 / 11) + 0.2 * (6 / 11)
    expect(deriveAstrologyBlend("aries", "cancer", "libra")).toBeCloseTo(expected)
  })
})
