// src/nft/codex-data/loader.ts — Codex Data Loader (Sprint 1 Task 1.5)
//
// Extensible loader for codex artifacts with SHA-256 checksum validation.
// Supports registering/loading arbitrary named artifacts via registerArtifact().

import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { verifySha256, readSha256File } from "./checksums.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArtifactRegistration {
  /** Human-readable artifact name */
  name: string
  /** Path to the JSON data file (relative to codex-data/) */
  path: string
  /** Path to the .sha256 checksum file (relative to codex-data/) */
  checksumPath: string
}

export interface LoadedArtifact<T = unknown> {
  name: string
  data: T
  checksum: string
  valid: boolean
}

// ---------------------------------------------------------------------------
// Molecule-Tarot Bijection Types
// ---------------------------------------------------------------------------

export interface MoleculeTarotEntry {
  molecule: string
  card: {
    name: string
    arcana: "major" | "minor"
    suit?: "wands" | "cups" | "swords" | "pentacles"
    number: number
  }
}

// ---------------------------------------------------------------------------
// Ancestor Types
// ---------------------------------------------------------------------------

export interface AncestorEntry {
  id: string
  name: string
  tradition: string
  era: string
  cognitive_style: string
  keywords: string[]
}

// ---------------------------------------------------------------------------
// Archetype Definition Types
// ---------------------------------------------------------------------------

export interface ArchetypeDefinitionEntry {
  id: string
  name: string
  season: string
  core_values: string[]
  voice_signature: {
    register: string
    cadence: string
    vocabulary: string
    affect: string
  }
  description: string
}

// ---------------------------------------------------------------------------
// Archetype Affinity Types
// ---------------------------------------------------------------------------

export interface ArchetypeAffinityWeight {
  archetype: string
  weight: number
}

export interface SuitAffinity {
  primary: ArchetypeAffinityWeight
  secondary: ArchetypeAffinityWeight
  tertiary: ArchetypeAffinityWeight
  quaternary: ArchetypeAffinityWeight
}

export interface ArchetypeAffinityData {
  description: string
  suit_affinity: Record<string, SuitAffinity>
  element_mapping: Record<string, string>
}

// ---------------------------------------------------------------------------
// Codex Version Types
// ---------------------------------------------------------------------------

export interface CodexVersionData {
  version: string
  sha: string
  description: string
  pinned_at: string
}

// ---------------------------------------------------------------------------
// DAPM Tables Types (Sprint 7 Task 7.2)
// ---------------------------------------------------------------------------

import type { DAPMDialId } from "../signal-types.js"

/** Full 96-dial offset record */
export type DialOffsetRecord = Record<DAPMDialId, number>

/** Partial dial overrides for mode deltas */
export type PartialDialRecord = Partial<Record<DAPMDialId, number>>

export interface DAPMTablesData {
  archetype_offsets: Record<string, DialOffsetRecord>
  ancestor_family_offsets: Record<string, DialOffsetRecord>
  era_offsets: Record<string, DialOffsetRecord>
  element_offsets: Record<string, DialOffsetRecord>
  tarot_suit_scales: Record<string, DialOffsetRecord>
  swag_dial_scales: DialOffsetRecord
  astrology_dial_offsets: DialOffsetRecord
  mode_deltas: Record<string, PartialDialRecord>
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** Registry of artifacts to load */
const registry: Map<string, ArtifactRegistration> = new Map()

/** Cache of loaded artifacts */
const cache: Map<string, LoadedArtifact> = new Map()

/**
 * Register an artifact for loading and checksum validation.
 * Extensible for later artifacts (dapm-tables.json in Sprint 7.2, graph.json in Sprint 9.0).
 */
export function registerArtifact(name: string, path: string, checksumPath: string): void {
  registry.set(name, { name, path, checksumPath })
  // Invalidate cache when re-registered
  cache.delete(name)
}

/**
 * Load and validate a single registered artifact.
 * Returns the parsed JSON data with checksum validation result.
 */
export function loadArtifact<T = unknown>(name: string): LoadedArtifact<T> {
  // Return cached if available
  const cached = cache.get(name)
  if (cached) return cached as LoadedArtifact<T>

  const reg = registry.get(name)
  if (!reg) {
    throw new Error(`Codex artifact not registered: ${name}`)
  }

  const dataPath = resolve(__dirname, reg.path)
  const checksumFilePath = resolve(__dirname, reg.checksumPath)

  // Read and parse JSON data
  const raw = readFileSync(dataPath, "utf-8")
  const data = JSON.parse(raw) as T

  // Validate checksum
  let valid = false
  let checksum = ""
  try {
    checksum = readSha256File(checksumFilePath)
    valid = verifySha256(dataPath, checksum)
  } catch {
    // Checksum file may not exist yet — not a hard failure
    valid = false
    checksum = "missing"
  }

  const loaded: LoadedArtifact<T> = { name, data, checksum, valid }
  cache.set(name, loaded as LoadedArtifact)
  return loaded
}

/**
 * Get all registered artifact names.
 */
export function getRegisteredArtifacts(): string[] {
  return Array.from(registry.keys())
}

/**
 * Clear the artifact cache (useful for testing).
 */
export function clearArtifactCache(): void {
  cache.clear()
}

// ---------------------------------------------------------------------------
// Default Registrations (built-in codex artifacts)
// ---------------------------------------------------------------------------

registerArtifact(
  "molecule-tarot-bijection",
  "molecule-tarot-bijection.json",
  "molecule-tarot-bijection.json.sha256",
)

registerArtifact(
  "ancestors",
  "ancestors.json",
  "ancestors.json.sha256",
)

registerArtifact(
  "archetype-definitions",
  "archetype-definitions.json",
  "archetype-definitions.json.sha256",
)

registerArtifact(
  "archetype-affinity",
  "archetype-affinity.json",
  "archetype-affinity.json.sha256",
)

registerArtifact(
  "codex-version",
  "codex-version.json",
  "codex-version.json.sha256",
)

registerArtifact(
  "dapm-tables",
  "dapm-tables.json",
  "dapm-tables.json.sha256",
)

registerArtifact(
  "knowledge-graph",
  "graph.json",
  "graph.json.sha256",
)

// ---------------------------------------------------------------------------
// Convenience Accessors
// ---------------------------------------------------------------------------

/** Load the 78-entry molecule-to-tarot bijection */
export function loadMoleculeTarotBijection(): MoleculeTarotEntry[] {
  return loadArtifact<MoleculeTarotEntry[]>("molecule-tarot-bijection").data
}

/** Load the 33 cultural ancestors */
export function loadAncestors(): AncestorEntry[] {
  return loadArtifact<AncestorEntry[]>("ancestors").data
}

/** Load the 4 archetype definitions */
export function loadArchetypeDefinitions(): ArchetypeDefinitionEntry[] {
  return loadArtifact<ArchetypeDefinitionEntry[]>("archetype-definitions").data
}

/** Load the archetype affinity mapping */
export function loadArchetypeAffinity(): ArchetypeAffinityData {
  return loadArtifact<ArchetypeAffinityData>("archetype-affinity").data
}

/** Load the codex version info */
export function loadCodexVersion(): CodexVersionData {
  return loadArtifact<CodexVersionData>("codex-version").data
}

/** Load the dAPM offset tables (Sprint 7 Task 7.2) */
export function loadDAPMTables(): DAPMTablesData {
  return loadArtifact<DAPMTablesData>("dapm-tables").data
}
