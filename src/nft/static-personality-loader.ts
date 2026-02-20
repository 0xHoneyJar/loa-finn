// src/nft/static-personality-loader.ts — Static Personality Loader (Sprint 4 T4.3, T4.4)
//
// Reads config/personalities.json at boot. Implements PersonalityProvider.
// Anti-narration validation (T4.4): every beauvoir_template is checked against
// checkAntiNarration() at load time. Any violation → boot fails.

import { readFileSync } from "node:fs"
import type { PersonalityProvider, PersonalityConfig } from "./personality-provider.js"
import type { Archetype } from "./signal-types.js"
import { ARCHETYPES } from "./signal-types.js"
import { checkAntiNarration } from "./reviewer-adapter.js"

// ---------------------------------------------------------------------------
// Config File Schema
// ---------------------------------------------------------------------------

interface PersonalitiesFile {
  personalities: PersonalityConfig[]
}

// ---------------------------------------------------------------------------
// StaticPersonalityLoader
// ---------------------------------------------------------------------------

/**
 * StaticPersonalityLoader — reads personalities from a JSON config file at boot.
 *
 * Boot-time guarantees:
 * 1. Config file exists and is valid JSON
 * 2. Every entry has required fields with correct types
 * 3. Every archetype value is one of the 4 valid archetypes
 * 4. Every beauvoir_template passes anti-narration validation (T4.4)
 *
 * If any check fails, the constructor throws and the process should not start.
 */
export class StaticPersonalityLoader implements PersonalityProvider {
  private readonly personalities: Map<string, PersonalityConfig>

  constructor(configPath: string) {
    this.personalities = loadAndValidate(configPath)
  }

  async get(tokenId: string): Promise<PersonalityConfig | null> {
    return this.personalities.get(tokenId) ?? null
  }

  async has(tokenId: string): Promise<boolean> {
    return this.personalities.has(tokenId)
  }

  /** Get all loaded personality configs (for enumeration/health checks). */
  getAll(): PersonalityConfig[] {
    return Array.from(this.personalities.values())
  }

  /** Get count of loaded personalities. */
  get size(): number {
    return this.personalities.size
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function loadAndValidate(configPath: string): Map<string, PersonalityConfig> {
  // 1. Read file
  let raw: string
  try {
    raw = readFileSync(configPath, "utf-8")
  } catch (err) {
    throw new Error(
      `Static personality config not found at ${configPath}: ${(err as Error).message}`,
    )
  }

  // 2. Parse JSON
  let data: PersonalitiesFile
  try {
    data = JSON.parse(raw) as PersonalitiesFile
  } catch (err) {
    throw new Error(
      `Static personality config is not valid JSON: ${(err as Error).message}`,
    )
  }

  // 3. Validate structure
  if (!Array.isArray(data.personalities)) {
    throw new Error("Static personality config must have a 'personalities' array")
  }

  if (data.personalities.length === 0) {
    throw new Error("Static personality config must have at least one personality entry")
  }

  const map = new Map<string, PersonalityConfig>()

  for (const entry of data.personalities) {
    // Required field validation
    validateRequiredString(entry, "token_id")
    validateRequiredString(entry, "archetype")
    validateRequiredString(entry, "display_name")
    validateRequiredString(entry, "voice_description")
    validateRequiredString(entry, "beauvoir_template")
    validateRequiredStringArray(entry, "behavioral_traits")
    validateRequiredStringArray(entry, "expertise_domains")

    // Archetype validation
    if (!ARCHETYPES.includes(entry.archetype as Archetype)) {
      throw new Error(
        `Personality "${entry.token_id}": invalid archetype "${entry.archetype}". ` +
        `Must be one of: ${ARCHETYPES.join(", ")}`,
      )
    }

    // T4.4: Anti-narration validation at boot
    const violations = checkAntiNarration(entry.beauvoir_template)
    if (violations.length > 0) {
      throw new Error(
        `Personality "${entry.token_id}" (${entry.archetype}): beauvoir_template ` +
        `contains forbidden anti-narration terms: [${violations.join(", ")}]. ` +
        `Templates must not expose identity metadata.`,
      )
    }

    // Duplicate tokenId check
    if (map.has(entry.token_id)) {
      throw new Error(
        `Duplicate token_id "${entry.token_id}" in static personality config`,
      )
    }

    map.set(entry.token_id, entry)
  }

  return map
}

function validateRequiredString(
  entry: Record<string, unknown>,
  field: string,
): asserts entry is Record<string, unknown> & Record<typeof field, string> {
  if (typeof entry[field] !== "string" || entry[field].length === 0) {
    const tokenId = typeof entry.token_id === "string" ? entry.token_id : "unknown"
    throw new Error(
      `Personality "${tokenId}": "${field}" must be a non-empty string`,
    )
  }
}

function validateRequiredStringArray(
  entry: Record<string, unknown>,
  field: string,
): void {
  const value = entry[field]
  if (!Array.isArray(value) || value.length === 0) {
    const tokenId = typeof entry.token_id === "string" ? entry.token_id : "unknown"
    throw new Error(
      `Personality "${tokenId}": "${field}" must be a non-empty array of strings`,
    )
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      const tokenId = typeof entry.token_id === "string" ? entry.token_id : "unknown"
      throw new Error(
        `Personality "${tokenId}": "${field}[${i}]" must be a string`,
      )
    }
  }
}
