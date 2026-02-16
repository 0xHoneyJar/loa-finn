// src/hounfour/knowledge-registry.ts — Knowledge Source Registry (SDD §3.3)

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { HounfourError } from "./errors.js"
import { loadKnowledgeSource } from "./knowledge-loader.js"
import type {
  KnowledgeSource,
  LoadedKnowledgeSource,
  KnowledgeSourcesConfig,
} from "./knowledge-types.js"

export interface RegistryHealth {
  healthy: boolean
  missing: string[]
  totalTokens: number
}

export class KnowledgeRegistry {
  private sources: Map<string, LoadedKnowledgeSource> = new Map()
  private config: KnowledgeSourcesConfig

  private constructor(config: KnowledgeSourcesConfig) {
    this.config = config
  }

  /** Factory: load and validate sources.json, then load all sources */
  static async fromConfig(configPath: string, projectRoot: string): Promise<KnowledgeRegistry> {
    const absPath = resolve(projectRoot, configPath)
    let raw: string
    try {
      raw = await readFile(absPath, "utf-8")
    } catch (err) {
      throw new HounfourError("CONFIG_INVALID",
        `Cannot read knowledge sources config: ${configPath}`, { path: configPath })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new HounfourError("CONFIG_INVALID",
        `Invalid JSON in knowledge sources config: ${configPath}`, { path: configPath })
    }

    const config = parsed as KnowledgeSourcesConfig

    // Schema validation (IMP-009)
    if (typeof config.version !== "number" || config.version !== 1) {
      throw new HounfourError("CONFIG_INVALID",
        `sources.json version must be 1 (number), got: ${config.version}`, { path: configPath })
    }
    if (!Array.isArray(config.sources) || config.sources.length === 0) {
      throw new HounfourError("CONFIG_INVALID",
        "sources.json must have a non-empty sources array", { path: configPath })
    }

    const seenIds = new Set<string>()
    for (const src of config.sources) {
      if (!src.id || typeof src.id !== "string") {
        throw new HounfourError("CONFIG_INVALID",
          "Each source must have a non-empty string id", { path: configPath })
      }
      if (src.type !== "local") {
        throw new HounfourError("CONFIG_INVALID",
          `Source type must be "local", got: ${src.type}`, { source_id: src.id })
      }
      if (!src.path || typeof src.path !== "string") {
        throw new HounfourError("CONFIG_INVALID",
          `Source ${src.id} must have a non-empty string path`, { source_id: src.id })
      }
      if (!Array.isArray(src.tags)) {
        throw new HounfourError("CONFIG_INVALID",
          `Source ${src.id} must have a tags array`, { source_id: src.id })
      }
      if (typeof src.priority !== "number") {
        throw new HounfourError("CONFIG_INVALID",
          `Source ${src.id} must have a numeric priority`, { source_id: src.id })
      }
      if (typeof src.maxTokens !== "number") {
        throw new HounfourError("CONFIG_INVALID",
          `Source ${src.id} must have a numeric maxTokens`, { source_id: src.id })
      }
      if (seenIds.has(src.id)) {
        throw new HounfourError("CONFIG_INVALID",
          `Duplicate source id: ${src.id}`, { source_id: src.id })
      }
      seenIds.add(src.id)
    }

    const registry = new KnowledgeRegistry(config)
    await registry.loadAllSources(projectRoot)
    return registry
  }

  private async loadAllSources(projectRoot: string): Promise<void> {
    for (const source of this.config.sources) {
      try {
        const loaded = await loadKnowledgeSource(source, projectRoot)
        if (loaded) {
          this.sources.set(source.id, loaded)
        } else {
          console.warn(`[hounfour] Knowledge source not found: ${source.id} (${source.path})`)
        }
      } catch (err) {
        console.warn(`[hounfour] Failed to load knowledge source ${source.id}: ${err instanceof Error ? err.message : err}`)
        // Individual failures are caught and logged — source is skipped
      }
    }
  }

  getSource(id: string): LoadedKnowledgeSource | undefined {
    return this.sources.get(id)
  }

  getSourcesByTags(tags: string[]): LoadedKnowledgeSource[] {
    return Array.from(this.sources.values()).filter(loaded =>
      loaded.source.tags.some(t => tags.includes(t))
    )
  }

  getAllSources(): LoadedKnowledgeSource[] {
    return Array.from(this.sources.values())
  }

  getDefaultBudget(): number {
    return this.config.default_budget_tokens ?? 30000
  }

  getGlossaryTerms(): Record<string, string[]> {
    return this.config.glossary_terms ?? {}
  }

  isHealthy(): RegistryHealth {
    const allRequired = this.config.sources.filter(s => s.required)
    const missing = allRequired
      .filter(s => !this.sources.has(s.id))
      .map(s => s.id)

    const totalTokens = Array.from(this.sources.values())
      .reduce((sum, s) => sum + s.tokenCount, 0)

    const loadedRequired = allRequired.length - missing.length
    const healthy = loadedRequired >= 3 && totalTokens >= 5000

    return { healthy, missing, totalTokens }
  }
}

/**
 * Deterministic oracle registration check (SDD SKP-003).
 * Evaluated once at startup — no runtime re-evaluation.
 */
export function shouldRegisterOracle(
  oracleEnabled: boolean,
  registry: KnowledgeRegistry | undefined,
): boolean {
  if (!oracleEnabled) return false
  if (!registry) return false
  return registry.isHealthy().healthy
}
