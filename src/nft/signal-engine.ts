// src/nft/signal-engine.ts — Signal Engine Core (SDD §1.2, Sprint 1 Tasks 1.3 + 1.4)
//
// Pure functions for signal construction, projection, and nested identity propagation.
// All derivation functions are deterministic: same input = same output.

import type {
  Archetype,
  Era,
  Element,
  SignalSnapshot,
  SignalCore8,
  AgentMode,
  SwagRank,
  ZodiacSign,
  TarotCard,
} from "./signal-types.js"

import {
  ERA_BOUNDARIES,
  SWAG_RANK_VALUES,
  ZODIAC_SIGNS,
} from "./signal-types.js"

import {
  loadMoleculeTarotBijection,
  loadArchetypeAffinity,
  loadAncestors,
  type MoleculeTarotEntry,
  type ArchetypeAffinityData,
  type AncestorEntry,
} from "./codex-data/loader.js"

// ---------------------------------------------------------------------------
// Lookup Caches (lazy-initialized from codex data)
// ---------------------------------------------------------------------------

let moleculeMap: Map<string, MoleculeTarotEntry> | null = null
let affinityData: ArchetypeAffinityData | null = null
let ancestorMap: Map<string, AncestorEntry> | null = null

function getMoleculeMap(): Map<string, MoleculeTarotEntry> {
  if (!moleculeMap) {
    const entries = loadMoleculeTarotBijection()
    moleculeMap = new Map(entries.map((e) => [e.molecule.toLowerCase(), e]))
  }
  return moleculeMap
}

function getAffinityData(): ArchetypeAffinityData {
  if (!affinityData) {
    affinityData = loadArchetypeAffinity()
  }
  return affinityData
}

function getAncestorMap(): Map<string, AncestorEntry> {
  if (!ancestorMap) {
    const entries = loadAncestors()
    ancestorMap = new Map(entries.map((e) => [e.id, e]))
  }
  return ancestorMap
}

/**
 * Reset internal caches. Useful for testing after re-registering artifacts.
 */
export function resetSignalEngineCaches(): void {
  moleculeMap = null
  affinityData = null
  ancestorMap = null
}

// ---------------------------------------------------------------------------
// Raw On-Chain Metadata Input
// ---------------------------------------------------------------------------

/** Minimal on-chain metadata needed to construct a SignalSnapshot */
export interface OnChainMetadata {
  archetype: Archetype
  ancestor: string
  birthday: string          // ISO date string, e.g. "1352-06-15"
  molecule: string           // Drug name
  swag_rank: SwagRank
  swag_score: number         // 0-100
  sun_sign: ZodiacSign
  moon_sign: ZodiacSign
  ascending_sign: ZodiacSign
}

// ---------------------------------------------------------------------------
// Era Derivation
// ---------------------------------------------------------------------------

/**
 * Derive era from a birthday string.
 * Parses the year from an ISO date string and maps to era via ERA_BOUNDARIES.
 *
 * @param birthday - ISO date string (e.g., "1352-06-15", "-500-01-01")
 * @returns The derived Era
 */
export function deriveEra(birthday: string): Era {
  const year = parseBirthdayYear(birthday)

  for (const [era, bounds] of Object.entries(ERA_BOUNDARIES) as [Era, { start: number; end: number }][]) {
    if (year >= bounds.start && year < bounds.end) {
      return era
    }
  }

  // Fallback: if year is below ancient start, still ancient
  return "ancient"
}

/**
 * Parse year from a birthday string. Handles negative years (BCE).
 */
function parseBirthdayYear(birthday: string): number {
  // Handle negative years: "-500-01-01"
  if (birthday.startsWith("-")) {
    const rest = birthday.slice(1)
    const yearStr = rest.split("-")[0]
    return -parseInt(yearStr, 10)
  }
  const yearStr = birthday.split("-")[0]
  return parseInt(yearStr, 10)
}

// ---------------------------------------------------------------------------
// Tarot Derivation (Bijective from molecule)
// ---------------------------------------------------------------------------

/**
 * Derive tarot card from molecule via the 78-entry bijection.
 * Lookup is case-insensitive on the molecule name.
 *
 * @param molecule - Drug/substance name
 * @returns The bijectively mapped TarotCard
 * @throws Error if molecule is not found in the bijection
 */
export function deriveTarot(molecule: string): TarotCard {
  const map = getMoleculeMap()
  const entry = map.get(molecule.toLowerCase())

  if (!entry) {
    throw new Error(`Molecule not found in bijection: ${molecule}`)
  }

  const card = entry.card
  const suit = card.arcana === "major" ? "major" as const : card.suit!
  const element = deriveElement(suit)

  return {
    name: card.name,
    number: card.number,
    suit,
    element,
  }
}

// ---------------------------------------------------------------------------
// Element Derivation (from tarot suit)
// ---------------------------------------------------------------------------

/** Suit-to-element mapping per SDD */
const SUIT_ELEMENT_MAP: Record<string, Element> = {
  wands: "fire",
  cups: "water",
  swords: "air",
  pentacles: "earth",
  major: "fire",  // Major Arcana defaults to fire
}

/**
 * Derive element from tarot suit.
 * wands=fire, cups=water, swords=air, pentacles=earth, major=fire
 *
 * @param suit - The tarot card suit
 * @returns The derived Element
 */
export function deriveElement(suit: "wands" | "cups" | "swords" | "pentacles" | "major"): Element {
  return SUIT_ELEMENT_MAP[suit]
}

// ---------------------------------------------------------------------------
// Archetype Affinity (from tarot suit via codex affinity table)
// ---------------------------------------------------------------------------

export interface ArchetypeAffinityResult {
  primary: { archetype: Archetype; weight: number }
  secondary: { archetype: Archetype; weight: number }
  tertiary: { archetype: Archetype; weight: number }
  quaternary: { archetype: Archetype; weight: number }
}

/**
 * Derive archetype affinity from tarot suit via the pinned affinity table.
 *
 * @param suit - The tarot card suit
 * @returns Weighted archetype affinities
 */
export function deriveArchetypeAffinity(suit: string): ArchetypeAffinityResult {
  const data = getAffinityData()
  const affinity = data.suit_affinity[suit]

  if (!affinity) {
    throw new Error(`No affinity mapping for suit: ${suit}`)
  }

  return {
    primary: { archetype: affinity.primary.archetype as Archetype, weight: affinity.primary.weight },
    secondary: { archetype: affinity.secondary.archetype as Archetype, weight: affinity.secondary.weight },
    tertiary: { archetype: affinity.tertiary.archetype as Archetype, weight: affinity.tertiary.weight },
    quaternary: { archetype: affinity.quaternary.archetype as Archetype, weight: affinity.quaternary.weight },
  }
}

// ---------------------------------------------------------------------------
// Ancestor Connection (from ancestor ID via codex ancestors table)
// ---------------------------------------------------------------------------

export interface AncestorConnection {
  id: string
  name: string
  tradition: string
  cognitive_style: string
  keywords: string[]
}

/**
 * Resolve ancestor connection from ancestor ID via codex data.
 *
 * @param ancestorId - The ancestor identifier
 * @returns Ancestor connection data, or null if not found
 */
export function resolveAncestorConnection(ancestorId: string): AncestorConnection | null {
  const map = getAncestorMap()
  const entry = map.get(ancestorId)

  if (!entry) return null

  return {
    id: entry.id,
    name: entry.name,
    tradition: entry.tradition,
    cognitive_style: entry.cognitive_style,
    keywords: entry.keywords,
  }
}

// ---------------------------------------------------------------------------
// Nested Identity Propagation (Task 1.4)
// ---------------------------------------------------------------------------

export interface IdentityChain {
  molecule: string
  tarot: TarotCard
  element: Element
  archetype_affinity: ArchetypeAffinityResult
  ancestor_connection: AncestorConnection | null
}

/**
 * Propagate a full identity chain from a single molecule signal.
 * Chain: molecule -> tarot card -> element (via suit) -> archetype affinity -> ancestor connection
 *
 * All lookups are from pinned codex data, not hardcoded.
 *
 * @param molecule - Drug/substance name
 * @param ancestorId - The ancestor identifier for connection resolution
 * @returns Full identity chain
 */
export function propagateIdentityChain(molecule: string, ancestorId: string): IdentityChain {
  // Step 1: molecule -> tarot card
  const tarot = deriveTarot(molecule)

  // Step 2: tarot suit -> element
  const element = tarot.element

  // Step 3: tarot suit -> archetype affinity
  const archetype_affinity = deriveArchetypeAffinity(tarot.suit)

  // Step 4: ancestor ID -> ancestor connection
  const ancestor_connection = resolveAncestorConnection(ancestorId)

  return {
    molecule,
    tarot,
    element,
    archetype_affinity,
    ancestor_connection,
  }
}

// ---------------------------------------------------------------------------
// Signal Snapshot Construction (Task 1.3)
// ---------------------------------------------------------------------------

/**
 * Build a complete SignalSnapshot from on-chain metadata.
 * Derives era, tarot, and element from raw metadata fields.
 * All derivation is deterministic.
 *
 * @param metadata - Raw on-chain metadata
 * @returns Complete SignalSnapshot with all derived fields
 */
export function buildSignalSnapshot(metadata: OnChainMetadata): SignalSnapshot {
  const era = deriveEra(metadata.birthday)
  const tarot = deriveTarot(metadata.molecule)
  const element = tarot.element

  return {
    archetype: metadata.archetype,
    ancestor: metadata.ancestor,
    birthday: metadata.birthday,
    era,
    molecule: metadata.molecule,
    tarot,
    element,
    swag_rank: metadata.swag_rank,
    swag_score: metadata.swag_score,
    sun_sign: metadata.sun_sign,
    moon_sign: metadata.moon_sign,
    ascending_sign: metadata.ascending_sign,
  }
}

// ---------------------------------------------------------------------------
// Signal Projection (12 -> 8 dimensions)
// ---------------------------------------------------------------------------

/** Zodiac sign to numeric value (0-1) for blending */
const ZODIAC_VALUES: Record<ZodiacSign, number> = {
  aries: 0.0,     taurus: 1/12,    gemini: 2/12,    cancer: 3/12,
  leo: 4/12,      virgo: 5/12,     libra: 6/12,     scorpio: 7/12,
  sagittarius: 8/12, capricorn: 9/12, aquarius: 10/12, pisces: 11/12,
}

/** Tarot card number to consciousness orientation (0-1) */
function tarotToConsciousness(tarot: TarotCard): number {
  // Normalize 0-77 range to 0-1
  return tarot.number / 77
}

/**
 * Project 12 SignalSnapshot fields into 8 canonical SignalCore8 dimensions.
 *
 * Projection logic:
 * - dim 1 (value_system): direct from archetype
 * - dim 2 (cultural_frame): direct from ancestor
 * - dim 3 (temporal_constraint): direct from era
 * - dim 4 (consciousness_orientation): from molecule+tarot (normalized card number)
 * - dim 5 (energy_style): direct from element
 * - dim 6 (presence_modifier): from swag_rank+score blend
 * - dim 7 (emotional_coloring): from sun+moon+rising zodiac blend
 * - dim 8 (task_override): from mode parameter
 *
 * @param snapshot - Complete SignalSnapshot
 * @param mode - Current agent mode (defaults to "default")
 * @returns Projected 8-dimensional SignalCore8
 */
export function projectSignals(snapshot: SignalSnapshot, mode: AgentMode = "default"): SignalCore8 {
  // dim 4: consciousness_orientation from molecule+tarot
  const consciousness = tarotToConsciousness(snapshot.tarot)

  // dim 6: presence_modifier from swag_rank + swag_score
  const rankValue = SWAG_RANK_VALUES[snapshot.swag_rank]
  const scoreNormalized = snapshot.swag_score / 100
  const presence = rankValue * 0.6 + scoreNormalized * 0.4

  // dim 7: emotional_coloring from zodiac triad blend
  const sunVal = ZODIAC_VALUES[snapshot.sun_sign]
  const moonVal = ZODIAC_VALUES[snapshot.moon_sign]
  const ascVal = ZODIAC_VALUES[snapshot.ascending_sign]
  const emotional = sunVal * 0.5 + moonVal * 0.3 + ascVal * 0.2

  return {
    value_system: snapshot.archetype,
    cultural_frame: snapshot.ancestor,
    temporal_constraint: snapshot.era,
    consciousness_orientation: consciousness,
    energy_style: snapshot.element,
    presence_modifier: presence,
    emotional_coloring: emotional,
    task_override: mode,
  }
}
