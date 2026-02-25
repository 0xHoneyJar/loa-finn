// src/hounfour/nft-routing-config.ts — NFT Personality-to-Model Mapping Config (SDD §4.8, Task C.1)
//
// Configuration format for NFT → preferred pool mapping with per-personality task routing.
// Validated against loa-hounfour RoutingPolicySchema. In-memory cache (~1000 entries).
//
// Routing vocabulary decision (cycle-033 Sprint 3, T-3.9):
//   6 protocol TaskTypes map to 5 NFTRoutingKeys because 'summarization' and 'analysis'
//   share a single routing destination. Rationale: both are "deep-think" tasks requiring
//   reasoning-capable models. This mirrors Kubernetes CRD patterns where multiple API
//   resources can map to the same controller — the routing layer is intentionally coarser
//   than the protocol's semantic type space, allowing pool operators to optimize for
//   capability tiers rather than individual task labels.

import { readFileSync } from "node:fs"
import { isValidPoolId, type PoolId, type Tier } from "@0xhoneyjar/loa-hounfour"
import type { TaskType } from "@0xhoneyjar/loa-hounfour/governance"
import { HounfourError } from "./errors.js"

// --- Types ---

/** Internal routing keys for NFT personality routing (not protocol TaskType values) */
export type NFTRoutingKey = "chat" | "analysis" | "architecture" | "code" | "default"

/** @deprecated Use NFTRoutingKey instead */
export type NFTTaskType = NFTRoutingKey

/** Per-task pool routing for a personality */
export interface TaskRouting {
  chat: PoolId
  analysis: PoolId
  architecture: PoolId
  code: PoolId
  default: PoolId
}

/** Optional per-personality preferences */
export interface PersonalityPreferences {
  temperature?: number
  max_tokens?: number
  system_prompt_path?: string
}

/** Single personality routing entry */
export interface PersonalityRouting {
  personality_id: string
  task_routing: TaskRouting
  preferences?: PersonalityPreferences
}

/** Full NFT routing config (validated against RoutingPolicySchema) */
export interface NFTRoutingPolicy {
  version: string
  personalities: PersonalityRouting[]
}

// --- Validation ---

const VALID_TASK_TYPES: readonly NFTRoutingKey[] = ["chat", "analysis", "architecture", "code", "default"]

/** Set of all known NFTRoutingKey values for runtime membership checks */
export const KNOWN_ROUTING_KEYS: ReadonlySet<NFTRoutingKey> = new Set(VALID_TASK_TYPES)

// --- Protocol TaskType → NFTRoutingKey mapping ---

/**
 * Known protocol TaskType literals as of v8.2.0.
 * If loa-hounfour adds a new literal to TaskTypeSchema, add it here and to mapKnownTaskType.
 */
export const KNOWN_TASK_TYPES = [
  "code_review", "creative_writing", "analysis", "summarization", "general", "unspecified",
] as const

/** Narrowed type: only the 6 known protocol TaskType literals (not the open `string`). */
export type KnownTaskType = typeof KNOWN_TASK_TYPES[number]

/**
 * Map a known protocol TaskType to an internal NFTRoutingKey.
 * No `default` branch — TypeScript compile error if a new variant is added
 * to KnownTaskType without being handled here.
 *
 * Protocol TaskType values (v8.2.0):
 *   code_review → code, creative_writing → chat, analysis → analysis,
 *   summarization → analysis, general → default, unspecified → default
 */
export function mapKnownTaskType(taskType: KnownTaskType): NFTRoutingKey {
  switch (taskType) {
    case "code_review":
      return "code"
    case "creative_writing":
      return "chat"
    case "analysis":
      return "analysis"
    case "summarization":
      return "analysis"
    case "general":
      return "default"
    case "unspecified":
      return "default"
  }
  // Exhaustiveness check — if TypeScript reports an error here, a new KnownTaskType
  // variant was added without being handled in the switch above.
  const _exhaustive: never = taskType
  throw new Error(`Unhandled TaskType: ${_exhaustive}`)
}

/**
 * Map a protocol TaskType to an internal NFTRoutingKey.
 * Delegates to mapKnownTaskType for known literals,
 * with a default fallback for community-defined types (open `string` union).
 */
export function mapTaskTypeToRoutingKey(taskType: TaskType): NFTRoutingKey {
  if ((KNOWN_TASK_TYPES as readonly string[]).includes(taskType)) {
    return mapKnownTaskType(taskType as KnownTaskType)
  }
  // Forward-compat: community-defined types (namespace:type) or future protocol types
  return "default"
}

/**
 * Map an unknown string to an NFTRoutingKey — total at runtime.
 * Handles protocol TaskType values, community-defined types, and arbitrary strings.
 *
 * - Known protocol TaskType → mapped routing key
 * - "unspecified" → "default"
 * - Unknown strings → "default" (with console.warn for observability)
 */
export function mapUnknownTaskTypeToRoutingKey(taskType: unknown): NFTRoutingKey {
  if (typeof taskType !== "string" || !taskType) {
    return "default"
  }
  // If it's already a valid routing key, pass through
  if (KNOWN_ROUTING_KEYS.has(taskType as NFTRoutingKey)) {
    return taskType as NFTRoutingKey
  }
  // Try protocol TaskType mapping
  const mapped = mapTaskTypeToRoutingKey(taskType as TaskType)
  if (mapped !== "default" || taskType === "general" || taskType === "unspecified") {
    return mapped
  }
  // Unknown string — warn and fall back to default (redact input to prevent log injection)
  console.warn(`[nft-routing] Unknown task type received — mapping to "default"`)
  return "default"
}

/**
 * Validate an NFT routing config against loa-hounfour RoutingPolicySchema constraints.
 * Returns array of validation errors (empty = valid).
 */
export function validateNFTRoutingConfig(config: unknown): string[] {
  const errors: string[] = []

  if (typeof config !== "object" || config === null) {
    return ["Config must be a non-null object"]
  }

  const c = config as Record<string, unknown>

  // Version
  if (typeof c.version !== "string" || !/^\d+\.\d+\.\d+$/.test(c.version)) {
    errors.push('version must be a semver string (e.g., "1.0.0")')
  }

  // Personalities array
  if (!Array.isArray(c.personalities)) {
    errors.push("personalities must be an array")
    return errors
  }

  const seenIds = new Set<string>()
  for (let i = 0; i < c.personalities.length; i++) {
    const p = c.personalities[i] as Record<string, unknown>
    const prefix = `personalities[${i}]`

    if (typeof p !== "object" || p === null) {
      errors.push(`${prefix} must be an object`)
      continue
    }

    // personality_id
    if (typeof p.personality_id !== "string" || p.personality_id.length === 0) {
      errors.push(`${prefix}.personality_id must be a non-empty string`)
    } else if (seenIds.has(p.personality_id as string)) {
      errors.push(`${prefix}.personality_id "${p.personality_id}" is duplicated`)
    } else {
      seenIds.add(p.personality_id as string)
    }

    // task_routing
    if (typeof p.task_routing !== "object" || p.task_routing === null) {
      errors.push(`${prefix}.task_routing must be an object`)
    } else {
      const tr = p.task_routing as Record<string, unknown>
      for (const taskType of VALID_TASK_TYPES) {
        if (typeof tr[taskType] !== "string") {
          errors.push(`${prefix}.task_routing.${taskType} is required and must be a string`)
        } else if (!isValidPoolId(tr[taskType] as string)) {
          errors.push(`${prefix}.task_routing.${taskType} = "${tr[taskType]}" is not a valid pool ID`)
        }
      }
    }

    // preferences (optional)
    if (p.preferences !== undefined) {
      if (typeof p.preferences !== "object" || p.preferences === null) {
        errors.push(`${prefix}.preferences must be an object if provided`)
      } else {
        const prefs = p.preferences as Record<string, unknown>
        if (prefs.temperature !== undefined) {
          if (typeof prefs.temperature !== "number" || prefs.temperature < 0 || prefs.temperature > 2) {
            errors.push(`${prefix}.preferences.temperature must be a number between 0 and 2`)
          }
        }
        if (prefs.max_tokens !== undefined) {
          if (typeof prefs.max_tokens !== "number" || prefs.max_tokens < 1 || !Number.isInteger(prefs.max_tokens)) {
            errors.push(`${prefix}.preferences.max_tokens must be a positive integer`)
          }
        }
        if (prefs.system_prompt_path !== undefined) {
          if (typeof prefs.system_prompt_path !== "string") {
            errors.push(`${prefix}.preferences.system_prompt_path must be a string`)
          }
        }
      }
    }
  }

  return errors
}

// --- In-Memory Cache ---

/**
 * NFT routing config cache with O(1) personality lookup.
 * Supports full-replace reload (no incremental updates).
 */
export class NFTRoutingCache {
  private personalities: Map<string, PersonalityRouting>
  private version: string
  private loadedAt: number

  constructor() {
    this.personalities = new Map()
    this.version = "0.0.0"
    this.loadedAt = 0
  }

  /**
   * Load config from a parsed object. Validates and performs full replace.
   * Throws if validation fails.
   */
  load(config: NFTRoutingPolicy): void {
    const errors = validateNFTRoutingConfig(config)
    if (errors.length > 0) {
      throw new HounfourError("CONFIG_INVALID",
        `NFT routing config validation failed: ${errors.join("; ")}`, { errors })
    }

    // Full replace — build new map then swap atomically
    const newMap = new Map<string, PersonalityRouting>()
    for (const p of config.personalities) {
      newMap.set(p.personality_id, p)
    }

    this.personalities = newMap
    this.version = config.version
    this.loadedAt = Date.now()
  }

  /**
   * Load config from a JSON file path.
   */
  loadFromFile(filePath: string): void {
    const raw = readFileSync(filePath, "utf-8")
    const config = JSON.parse(raw) as NFTRoutingPolicy
    this.load(config)
  }

  /**
   * Resolve pool for a personality + task type.
   * Returns null if personality not found (caller should fall back to tier default).
   */
  resolvePool(personalityId: string, taskType: NFTTaskType): PoolId | null {
    const personality = this.personalities.get(personalityId)
    if (!personality) return null

    const poolId = personality.task_routing[taskType] ?? personality.task_routing.default
    return poolId
  }

  /**
   * Get preferences for a personality.
   */
  getPreferences(personalityId: string): PersonalityPreferences | null {
    const personality = this.personalities.get(personalityId)
    return personality?.preferences ?? null
  }

  /**
   * Get the full personality routing entry.
   */
  getPersonality(personalityId: string): PersonalityRouting | null {
    return this.personalities.get(personalityId) ?? null
  }

  /** Check if a personality exists in the cache */
  has(personalityId: string): boolean {
    return this.personalities.has(personalityId)
  }

  /** Number of cached personalities */
  get size(): number {
    return this.personalities.size
  }

  /** Config version */
  getVersion(): string {
    return this.version
  }

  /** Timestamp of last load */
  getLoadedAt(): number {
    return this.loadedAt
  }

  /** List all personality IDs */
  listPersonalities(): string[] {
    return Array.from(this.personalities.keys())
  }

  /** Clear all cached entries */
  clear(): void {
    this.personalities.clear()
    this.version = "0.0.0"
    this.loadedAt = 0
  }
}
