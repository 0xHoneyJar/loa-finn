// src/nft/dapm.ts — dAPM-96 Derivation Engine (SDD §3.1, Sprint 7 Tasks 7.1, 7.3–7.5)
//
// Pure, deterministic derivation of 96-dial personality fingerprints from SignalSnapshot.
// Composition formula:
//   dial_i = clamp(0.5 + 0.50*f1_i + 0.30*f2_i + 0.15*f3_i + 0.05*mode_i, 0, 1)
//
// Tier 1 (f1): archetype offsets
// Tier 2 (f2): (era + ancestor_family) / 2
// Tier 3 (f3): (element + swag_scale * swag_dial + astrology_blend * astrology_dial) / 3
// Mode:        partial overrides from mode_deltas

import type {
  SignalSnapshot,
  AgentMode,
  DAPMDialId,
  DAPMFingerprint,
  SwagRank,
  ZodiacSign,
} from "./signal-types.js"

import { DAPM_DIAL_IDS, SWAG_RANK_VALUES, ZODIAC_SIGNS } from "./signal-types.js"

import { getDAPMTables } from "./dapm-tables.js"
import { loadCodexVersion, loadAncestors } from "./codex-data/loader.js"
import type { AncestorEntry } from "./codex-data/loader.js"
import type { KnowledgeGraph } from "./identity-graph.js"

// ---------------------------------------------------------------------------
// Ancestor Family Types & Mapping (Task 7.3)
// ---------------------------------------------------------------------------

export type AncestorFamily =
  | "hellenic"
  | "dharmic"
  | "mystical"
  | "indigenous"
  | "celtic_norse"
  | "east_asian"
  | "african_diasporic"
  | "techno_modern"

export const ANCESTOR_FAMILIES: readonly AncestorFamily[] = [
  "hellenic", "dharmic", "mystical", "indigenous",
  "celtic_norse", "east_asian", "african_diasporic", "techno_modern",
] as const

/**
 * Maps all 33 ancestors to their family grouping.
 * Sourced from ancestors.json traditions.
 */
export const ANCESTOR_TO_FAMILY: Record<string, AncestorFamily> = {
  // Hellenic (Greek philosophical traditions)
  greek_philosopher: "hellenic",
  stoic_philosopher: "hellenic",
  cynical_philosopher: "hellenic",
  pythagorean: "hellenic",

  // Dharmic (Indian subcontinent spiritual traditions)
  buddhist_monk: "dharmic",
  vedic_rishi: "dharmic",
  tantric_adept: "dharmic",

  // Mystical (esoteric, hermetic, syncretic traditions)
  sufi_mystic: "mystical",
  alchemist: "mystical",
  sufi_poet: "mystical",
  hermetic_magician: "mystical",
  egyptian_priest: "mystical",

  // Indigenous (land-based, oral traditions)
  aboriginal_elder: "indigenous",
  navajo_singer: "indigenous",
  amazonian_curandero: "indigenous",
  shamanic_healer: "indigenous",
  mayan_astronomer: "indigenous",

  // Celtic/Norse (Northern European traditions)
  celtic_druid: "celtic_norse",
  norse_skald: "celtic_norse",

  // East Asian (Confucian, Taoist, Zen, Japanese aesthetic)
  taoist_sage: "east_asian",
  zen_master: "east_asian",
  confucian_scholar: "east_asian",
  japanese_aesthetic: "east_asian",

  // African Diasporic (Yoruba, Vodou, Afrofuturism)
  yoruba_babalawo: "african_diasporic",
  vodou_priestess: "african_diasporic",
  afrofuturist: "african_diasporic",

  // Techno-Modern (contemporary, digital, accelerationist)
  cypherpunk: "techno_modern",
  beat_poet: "techno_modern",
  situationist: "techno_modern",
  rave_shaman: "techno_modern",
  techno_philosopher: "techno_modern",
  renaissance_polymath: "techno_modern",
  german_idealist: "techno_modern",
}

// KnowledgeGraph type re-exported from identity-graph.ts (Sprint 9)
export type { KnowledgeGraph } from "./identity-graph.js"

/**
 * Resolve an ancestor name to its family grouping.
 *
 * Without graph: direct table lookup, defaults to "mystical" for unknown ancestors.
 * With graph: table lookup first, then graph traversal fallback for unknown ancestors.
 * Graph traversal finds edges from ancestor node to ancestor_family nodes,
 * picks the one with highest weight, with lexicographic tie-breaking.
 *
 * @param ancestor - Ancestor ID string (e.g., "greek_philosopher")
 * @param graph - Optional knowledge graph for enhanced resolution (Sprint 9)
 * @returns The ancestor's family grouping
 */
export function resolveAncestorFamily(
  ancestor: string,
  graph?: KnowledgeGraph | null,
): AncestorFamily {
  // Direct table lookup first (known ancestors)
  const tableLookup = ANCESTOR_TO_FAMILY[ancestor]
  if (tableLookup) return tableLookup

  // Graph fallback: find ancestor node, look for edges to ancestor_family nodes,
  // pick highest weight, lexicographic tie-breaking
  if (graph) {
    const ancestorNodeId = ancestor.startsWith("ancestor:") ? ancestor : `ancestor:${ancestor}`
    const adjacent = graph.adjacency.get(ancestorNodeId) ?? []

    let bestFamily: AncestorFamily | null = null
    let bestWeight = -1

    for (const edge of adjacent) {
      if (edge.target.startsWith("ancestor_family:")) {
        const familyName = edge.target.replace("ancestor_family:", "")
        if (ANCESTOR_FAMILIES.includes(familyName as AncestorFamily)) {
          if (
            edge.weight > bestWeight ||
            (edge.weight === bestWeight && bestFamily !== null && familyName < bestFamily)
          ) {
            bestWeight = edge.weight
            bestFamily = familyName as AncestorFamily
          }
        }
      }
    }

    if (bestFamily) return bestFamily
  }

  return "mystical" // Ultimate fallback
}

// ---------------------------------------------------------------------------
// Swag Normalization (Task 7.4)
// ---------------------------------------------------------------------------

/**
 * Normalize swag rank + score into a single [0, 1] value.
 *
 * Formula: 0.7 * SWAG_RANK_VALUES[rank] + 0.3 * (score / 100)
 * Result always clamped to [0, 1].
 *
 * @param rank - SwagRank tier (SSS through F)
 * @param score - Continuous score 0-100
 * @returns Normalized swag value in [0, 1]
 */
export function normalizeSwag(rank: SwagRank, score: number): number {
  const rankValue = SWAG_RANK_VALUES[rank]
  const normalized = 0.7 * rankValue + 0.3 * (score / 100)
  return Math.max(0, Math.min(1, normalized))
}

// ---------------------------------------------------------------------------
// Astrology Blending (Task 7.5)
// ---------------------------------------------------------------------------

/** Zodiac ordinals: Aries=0 ... Pisces=11 */
const ZODIAC_ORDINALS: Record<ZodiacSign, number> = {
  aries: 0, taurus: 1, gemini: 2, cancer: 3,
  leo: 4, virgo: 5, libra: 6, scorpio: 7,
  sagittarius: 8, capricorn: 9, aquarius: 10, pisces: 11,
}

/**
 * Derive a blended astrology value from sun, moon, and rising signs.
 *
 * Ordinals: Aries=0 ... Pisces=11, normalized by /11.
 * Weights: sun=0.5, moon=0.3, rising=0.2
 *
 * @returns Blended value in [0, 1]
 */
export function deriveAstrologyBlend(
  sun: ZodiacSign,
  moon: ZodiacSign,
  rising: ZodiacSign,
): number {
  const sunOrd = ZODIAC_ORDINALS[sun] / 11
  const moonOrd = ZODIAC_ORDINALS[moon] / 11
  const risingOrd = ZODIAC_ORDINALS[rising] / 11
  return 0.5 * sunOrd + 0.3 * moonOrd + 0.2 * risingOrd
}

// ---------------------------------------------------------------------------
// Core Composition Function (Task 7.1)
// ---------------------------------------------------------------------------

/** Clamp a value to [0, 1] */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/**
 * Clamp a mode offset to the safe range [-0.3, +0.3].
 * Mode deltas beyond this range could overwhelm the composition formula.
 * Defense-in-depth: data files should already be capped, this enforces at runtime.
 */
export function clampModeOffset(v: number): number {
  return Math.max(-0.3, Math.min(0.3, v))
}

/**
 * Derive a full 96-dial dAPM fingerprint from a SignalSnapshot and agent mode.
 *
 * Pure function — deterministic: same inputs always produce the same output.
 *
 * Formula per dial:
 *   dial_i = clamp(0.5 + 0.50*f1_i + 0.30*f2_i + 0.15*f3_i + 0.05*mode_i, 0, 1)
 *
 * Where:
 *   f1_i = archetype_offsets[archetype][dial_i]
 *   f2_i = (era_offsets[era][dial_i] + ancestor_family_offsets[family][dial_i]) / 2
 *   f3_i = (element_offsets[element][dial_i] + swag_norm * swag_dial_scales[dial_i] + astro_blend * astrology_dial_offsets[dial_i]) / 3
 *   mode_i = mode_deltas[mode][dial_i] ?? 0
 *
 * @param snapshot - Full signal state for this NFT
 * @param mode - Current agent mode (default, brainstorm, critique, execute)
 * @returns Complete 96-dial DAPMFingerprint
 */
export function deriveDAPM(
  snapshot: SignalSnapshot,
  mode: AgentMode,
): DAPMFingerprint {
  const tables = getDAPMTables()
  const codexVersion = loadCodexVersion()

  // Resolve composite inputs
  const family = resolveAncestorFamily(snapshot.ancestor)
  const swagNorm = normalizeSwag(snapshot.swag_rank, snapshot.swag_score)
  const astrologyBlend = deriveAstrologyBlend(
    snapshot.sun_sign,
    snapshot.moon_sign,
    snapshot.ascending_sign,
  )

  // Look up table rows — fail fast if any required table row is missing
  const archetypeRow = tables.archetype_offsets[snapshot.archetype]
  const eraRow = tables.era_offsets[snapshot.era]
  const familyRow = tables.ancestor_family_offsets[family]
  const elementRow = tables.element_offsets[snapshot.element]
  const swagScales = tables.swag_dial_scales
  const astrologyOffsets = tables.astrology_dial_offsets
  const modeDeltas = tables.mode_deltas[mode] ?? {}

  if (!archetypeRow) {
    throw new Error(`Missing DAPM archetype_offsets row for: ${snapshot.archetype}`)
  }
  if (!eraRow) {
    throw new Error(`Missing DAPM era_offsets row for: ${snapshot.era}`)
  }
  if (!familyRow) {
    throw new Error(`Missing DAPM ancestor_family_offsets row for: ${family}`)
  }
  if (!elementRow) {
    throw new Error(`Missing DAPM element_offsets row for: ${snapshot.element}`)
  }

  // Compute all 96 dials
  const dials = {} as Record<DAPMDialId, number>

  for (const dialId of DAPM_DIAL_IDS) {
    // Tier 1: archetype (weight 0.50)
    const f1 = archetypeRow[dialId] ?? 0

    // Tier 2: (era + ancestor_family) / 2 (weight 0.30)
    const f2 = ((eraRow[dialId] ?? 0) + (familyRow[dialId] ?? 0)) / 2

    // Tier 3: (element + swag*scale + astrology*offset) / 3 (weight 0.15)
    const f3 = ((elementRow[dialId] ?? 0) + swagNorm * (swagScales[dialId] ?? 0) + astrologyBlend * (astrologyOffsets[dialId] ?? 0)) / 3

    // Mode offset (weight 0.05), clamped to [-0.3, +0.3] for safety
    const modeOffset = clampModeOffset(modeDeltas[dialId] ?? 0)

    // Compose
    dials[dialId] = clamp01(0.5 + 0.50 * f1 + 0.30 * f2 + 0.15 * f3 + 0.05 * modeOffset)
  }

  return {
    dials,
    mode,
    derived_from: codexVersion.sha,
    derived_at: Date.now(),
  }
}
