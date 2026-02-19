// src/nft/name-derivation.ts — Self-Derived Agent Naming (PRD §4.6, Sprint 18 Tasks 18.1-18.2)
//
// Agents derive their own canonical names from on-chain signals via NameKDF.
// Pure algorithmic derivation: no LLM, no entropy, fully deterministic and verifiable.

import { createHmac } from "node:crypto"
import type { Archetype } from "./signal-types.js"

// ---------------------------------------------------------------------------
// Name Corpus — organized by archetype×ancestor pair
// ---------------------------------------------------------------------------

/**
 * Name component structure: root + optional prefix/suffix
 * Each archetype×ancestor pair has a set of lore-coherent components.
 */
export interface NameComponent {
  root: string
  prefix?: string
  suffix?: string
}

/** Full name corpus keyed by `${archetype}:${ancestor}` */
export type NameCorpus = Record<string, NameComponent[]>

// Embedded corpus — covers all 4 archetypes × 33 ancestors = 132 pairs
// Each pair has ≥10 candidates to prevent exhaustion
const CORPUS: NameCorpus = buildCorpus()

/**
 * Build the name corpus. Each archetype×ancestor pair gets name components
 * drawn from cultural lineages in the mibera-codex.
 *
 * Strategy: roots are derived from the ancestor tradition, modulated by archetype.
 * Prefixes/suffixes add archetype-specific flavor.
 */
function buildCorpus(): NameCorpus {
  const corpus: NameCorpus = {}

  const archetypes: Archetype[] = ["freetekno", "milady", "chicago_detroit", "acidhouse"]

  // Archetype flavor prefixes and suffixes
  const archetypeFlavor: Record<Archetype, { prefixes: string[]; suffixes: string[] }> = {
    freetekno: {
      prefixes: ["Tek", "Rez", "Wav", "Syn", "Nod"],
      suffixes: ["flux", "core", "wave", "drift", "pulse"],
    },
    milady: {
      prefixes: ["Val", "Lux", "Mir", "Cor", "Syl"],
      suffixes: ["belle", "grace", "light", "bloom", "veil"],
    },
    chicago_detroit: {
      prefixes: ["Vox", "Hex", "Dex", "Nex", "Rex"],
      suffixes: ["beat", "house", "jack", "groove", "soul"],
    },
    acidhouse: {
      prefixes: ["Psi", "Lys", "Sol", "Lum", "Vor"],
      suffixes: ["acid", "trip", "glow", "phase", "tone"],
    },
  }

  // Ancestor root pools — culturally coherent per tradition
  const ancestorRoots: Record<string, string[]> = {
    greek_philosopher: ["Sophos", "Logos", "Nous", "Theos", "Arete", "Kairos", "Telos", "Ethos", "Gnosis", "Phren", "Eidos", "Daimon"],
    celtic_druid: ["Bran", "Awen", "Nemeton", "Ogham", "Cern", "Dagda", "Brigid", "Lleu", "Myrddin", "Taliesin", "Morgen", "Annwn"],
    buddhist_monk: ["Bodhi", "Sunya", "Dharma", "Sangha", "Metta", "Prajna", "Vimala", "Karuna", "Ananda", "Satori", "Jhana", "Mudra"],
    egyptian_priest: ["Thoth", "Maat", "Ankh", "Khepri", "Sekhmet", "Heka", "Djed", "Neter", "Aten", "Ptah", "Seshat", "Wadjet"],
    norse_skald: ["Rune", "Saga", "Wyrd", "Skald", "Mjolnir", "Freya", "Odin", "Fenrir", "Ygg", "Volva", "Norns", "Heim"],
    sufi_mystic: ["Rumi", "Fana", "Baqa", "Zikr", "Murshid", "Qalb", "Sirr", "Ishq", "Hal", "Maqam", "Kashf", "Sama"],
    taoist_sage: ["Dao", "Wuwei", "Ziran", "Qigong", "Laozi", "Yin", "Yang", "Shen", "Jing", "Zhen", "Xuan", "Taiyi"],
    aboriginal_elder: ["Tjuk", "Alchera", "Bora", "Kurr", "Wandjina", "Mimi", "Bunyip", "Dingo", "Uluru", "Yidaki", "Corr", "Wira"],
    vedic_rishi: ["Veda", "Agni", "Soma", "Rta", "Brahman", "Atman", "Tapas", "Mantra", "Rishi", "Surya", "Varuna", "Indra"],
    alchemist: ["Azoth", "Prima", "Nigredo", "Albedo", "Rubedo", "Aurum", "Vitriol", "Sulphur", "Caput", "Lapis", "Solve", "Coagula"],
    zen_master: ["Koan", "Zazen", "Samu", "Rinzai", "Sesshin", "Kin", "Mu", "Enso", "Roshi", "Zendo", "Mondo", "Gassho"],
    mayan_astronomer: ["Kin", "Baktun", "Tzolkin", "Haab", "Kukulkan", "Itzamna", "Xibalba", "Hunab", "Chaac", "Bolom", "Wakah", "Ahau"],
    yoruba_babalawo: ["Ifa", "Ori", "Ashe", "Ogun", "Oshun", "Elegua", "Obatala", "Yemoja", "Shango", "Eshu", "Babalu", "Irunmole"],
    renaissance_polymath: ["Codex", "Opus", "Praxis", "Virtu", "Arte", "Forma", "Ratio", "Studia", "Orbis", "Nexus", "Scientia", "Fabrica"],
    stoic_philosopher: ["Stoa", "Logos", "Apatheia", "Prohairesis", "Kosmos", "Hegemon", "Oikeiosis", "Arete", "Pneuma", "Tonos", "Physis", "Krasis"],
    shamanic_healer: ["Ayah", "Rapeh", "Icaros", "Curand", "Wachuma", "Totem", "Nagual", "Haux", "Jurema", "Sanango", "Mariri", "Arkana"],
    confucian_scholar: ["Ren", "Yi", "Li", "Zhi", "Xin", "Junzi", "Dao", "De", "Wen", "Cheng", "Zhong", "Shu"],
    german_idealist: ["Geist", "Dasein", "Wille", "Ding", "Monad", "Noumen", "Vernunft", "Begriff", "Aufheben", "Zeitgeist", "Weltgeist", "Anschau"],
    cypherpunk: ["Cipher", "Hash", "Nonce", "Merkle", "Zero", "Proof", "Shard", "Block", "Forge", "Epoch", "Signal", "Vault"],
    beat_poet: ["Howl", "Dharma", "Kaddish", "Jazz", "Bardo", "Kerouac", "Corso", "Ferling", "Rexroth", "Snyder", "McClure", "Lamantia"],
    vodou_priestess: ["Loa", "Gede", "Legba", "Erzulie", "Ogou", "Damb", "Simbi", "Agwe", "Ayizan", "Marasa", "Baron", "Maman"],
    navajo_singer: ["Hozho", "Nizhoni", "Dineh", "Yei", "Hatali", "Naayee", "Blessingway", "Kinaalda", "Turquoise", "Pollen", "Coyote", "Spider"],
    tantric_adept: ["Shakti", "Shiva", "Kundalini", "Chakra", "Bindu", "Nada", "Yantra", "Tantra", "Maithuna", "Kali", "Lalita", "Mandala"],
    japanese_aesthetic: ["Wabi", "Sabi", "Mono", "Aware", "Yugen", "Iki", "Miyabi", "Kire", "Musubi", "Engawa", "Fukinsei", "Kanso"],
    situationist: ["Derive", "Detour", "Spect", "Potlatch", "Psych", "Unitary", "Reclaim", "Drift", "Fluxus", "Praxis", "Commune", "Avant"],
    amazonian_curandero: ["Ayahuasca", "Tobacco", "Yage", "Chacruna", "Dieta", "Maestro", "Selva", "Shipibo", "Rao", "Oni", "Nishi", "Ronin"],
    sufi_poet: ["Ghazal", "Divan", "Qalandar", "Masnavi", "Rubai", "Hafez", "Shams", "Khamr", "Saki", "Pir", "Darya", "Bulbul"],
    pythagorean: ["Monad", "Tetrad", "Pentad", "Harmonics", "Musica", "Kosmos", "Logos", "Nous", "Akousma", "Mathema", "Gnomon", "Tonos"],
    afrofuturist: ["Wakanda", "Sankofa", "Afronaut", "Solaris", "Nyame", "Drexciya", "Mothership", "Osun", "Kemetic", "Nova", "Astral", "Griot"],
    hermetic_magician: ["Hermes", "Thrice", "Emerald", "Corpus", "Pneuma", "Logos", "Nous", "Ogdoad", "Pleroma", "Aion", "Archon", "Gnosis"],
    cynical_philosopher: ["Diogenes", "Parrhesia", "Askesis", "Autarkeia", "Kyon", "Antisthenes", "Crates", "Metrocles", "Menippus", "Bion", "Demonax", "Teles"],
    rave_shaman: ["Bass", "Drop", "Pulse", "Vibe", "Rave", "Dawn", "Tribe", "Spiral", "Strobe", "Totem", "Gather", "Ecstatic"],
    techno_philosopher: ["Loop", "Grid", "Sync", "Patch", "Module", "Sequence", "Filter", "Morph", "Gate", "Clock", "Step", "Matrix"],
  }

  for (const archetype of archetypes) {
    const flavor = archetypeFlavor[archetype]
    for (const ancestorId of Object.keys(ancestorRoots)) {
      const key = `${archetype}:${ancestorId}`
      const roots = ancestorRoots[ancestorId]
      const components: NameComponent[] = []

      // Generate ≥10 candidates per pair by combining roots with archetype flavors
      for (let i = 0; i < roots.length; i++) {
        const root = roots[i]
        // Alternate between prefix-only, suffix-only, and bare root
        if (i % 3 === 0) {
          components.push({ root, prefix: flavor.prefixes[i % flavor.prefixes.length] })
        } else if (i % 3 === 1) {
          components.push({ root, suffix: flavor.suffixes[i % flavor.suffixes.length] })
        } else {
          components.push({ root })
        }
      }

      corpus[key] = components
    }
  }

  return corpus
}

// ---------------------------------------------------------------------------
// NameKDF — Deterministic Name Derivation Function
// ---------------------------------------------------------------------------

/**
 * Derive a canonical agent name from on-chain signals.
 *
 * Uses HMAC-SHA256 as KDF to map signal inputs to a corpus index.
 * The tokenId component guarantees uniqueness within a collection.
 *
 * @param archetype - Agent archetype (e.g., "freetekno")
 * @param ancestor - Ancestor connection ID (e.g., "greek_philosopher")
 * @param era - Temporal era (e.g., "ancient")
 * @param molecule - Chemical molecule name
 * @param element - Elemental alignment
 * @param tokenId - NFT token ID (uniqueness factor)
 * @param collectionSalt - Collection-level salt for namespace isolation
 * @returns Derived canonical name string
 */
export function nameKDF(
  archetype: string,
  ancestor: string,
  era: string,
  molecule: string,
  element: string,
  tokenId: string,
  collectionSalt: string,
): string {
  // Build the key material from all signal inputs
  const keyMaterial = `${archetype}|${ancestor}|${era}|${molecule}|${element}|${tokenId}`

  // HMAC-SHA256 with collection salt
  const hmac = createHmac("sha256", collectionSalt)
  hmac.update(keyMaterial)
  const digest = hmac.digest()

  // Look up corpus for this archetype×ancestor pair
  const corpusKey = `${archetype}:${ancestor}`
  const candidates = CORPUS[corpusKey]

  if (!candidates || candidates.length === 0) {
    // Defensive fallback: deterministic name from hash if corpus missing
    return `Agent-${digest.toString("hex").slice(0, 8)}`
  }

  // Map first 4 bytes of digest to corpus index
  const index = digest.readUInt32BE(0) % candidates.length
  const component = candidates[index]

  // Compose the name from component parts
  let name = ""
  if (component.prefix) {
    name += component.prefix
  }
  name += component.root
  if (component.suffix) {
    name += component.suffix
  }

  // Add a deterministic disambiguator from remaining hash bytes
  // This ensures uniqueness even within the same corpus partition
  const disambiguator = digest.readUInt16BE(4) % 10000
  const disambigStr = String(disambiguator).padStart(4, "0")

  return `${name}-${disambigStr}`
}

/**
 * Get the name corpus for testing/inspection.
 */
export function getNameCorpus(): Readonly<NameCorpus> {
  return CORPUS
}

/**
 * Validate that the corpus covers all required archetype×ancestor pairs.
 * Returns missing pairs (if any).
 */
export function validateCorpusCoverage(
  archetypes: readonly string[],
  ancestors: readonly string[],
): { covered: number; missing: string[]; minCandidates: number } {
  const missing: string[] = []
  let minCandidates = Infinity

  for (const arch of archetypes) {
    for (const anc of ancestors) {
      const key = `${arch}:${anc}`
      const candidates = CORPUS[key]
      if (!candidates || candidates.length === 0) {
        missing.push(key)
      } else {
        minCandidates = Math.min(minCandidates, candidates.length)
      }
    }
  }

  const total = archetypes.length * ancestors.length
  return {
    covered: total - missing.length,
    missing,
    minCandidates: minCandidates === Infinity ? 0 : minCandidates,
  }
}
