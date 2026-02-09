// src/hounfour/pool-registry.ts — Model Pool Registry (SDD §3.2, T-A.4)
// Canonical mapping from pool IDs to provider/model configurations.
// All routing uses pool IDs — JWT claims never contain raw model names.

import type { ModelCapabilities } from "./types.js"

// --- Types ---

export type Tier = "free" | "pro" | "enterprise"

export interface PoolDefinition {
  id: string
  description: string
  provider: string
  model: string
  fallback?: string
  capabilities: ModelCapabilities
  tierAccess: Tier[]
}

export interface PoolConfig {
  id: string
  description: string
  provider: string
  model: string
  fallback?: string
  capabilities: ModelCapabilities
  tierAccess: Tier[]
}

export interface PoolValidationResult {
  valid: boolean
  errors: string[]
}

// --- Default Pool Definitions ---

export const DEFAULT_POOLS: PoolConfig[] = [
  {
    id: "cheap",
    description: "Low-cost general purpose",
    provider: "qwen-local",
    model: "Qwen/Qwen2.5-7B-Instruct",
    capabilities: { tool_calling: true, thinking_traces: false, vision: false, streaming: true },
    tierAccess: ["free", "pro", "enterprise"],
  },
  {
    id: "fast-code",
    description: "Fast code completion and generation",
    provider: "qwen-local",
    model: "Qwen/Qwen2.5-Coder-7B-Instruct",
    fallback: "cheap",
    capabilities: { tool_calling: true, thinking_traces: false, vision: false, streaming: true },
    tierAccess: ["pro", "enterprise"],
  },
  {
    id: "reviewer",
    description: "Code review and analysis",
    provider: "openai",
    model: "gpt-4o",
    fallback: "fast-code",
    capabilities: { tool_calling: true, thinking_traces: false, vision: true, streaming: true },
    tierAccess: ["pro", "enterprise"],
  },
  {
    id: "reasoning",
    description: "Complex reasoning and planning",
    provider: "openai",
    model: "o3",
    fallback: "reviewer",
    capabilities: { tool_calling: true, thinking_traces: true, vision: false, streaming: true },
    tierAccess: ["enterprise"],
  },
  {
    id: "architect",
    description: "Architecture design and high-level planning",
    provider: "anthropic",
    model: "claude-opus-4-6",
    fallback: "reasoning",
    capabilities: { tool_calling: true, thinking_traces: true, vision: true, streaming: true },
    tierAccess: ["enterprise"],
  },
]

// --- Pool Registry ---

export class PoolRegistry {
  private pools = new Map<string, PoolDefinition>()

  constructor(configs: PoolConfig[]) {
    for (const config of configs) {
      if (this.pools.has(config.id)) {
        throw new Error(`Duplicate pool ID: ${config.id}`)
      }
      this.pools.set(config.id, { ...config })
    }

    // Validate fallback references
    for (const pool of this.pools.values()) {
      if (pool.fallback && !this.pools.has(pool.fallback)) {
        throw new Error(`Pool "${pool.id}" references unknown fallback "${pool.fallback}"`)
      }
    }

    // Detect circular fallback chains
    for (const pool of this.pools.values()) {
      this.detectCycle(pool.id)
    }
  }

  /** Resolve a pool ID to its definition. Returns null if not found. */
  resolve(poolId: string): PoolDefinition | null {
    return this.pools.get(poolId) ?? null
  }

  /** Check if a tier is authorized to use a pool. */
  authorize(poolId: string, tier: Tier): boolean {
    const pool = this.pools.get(poolId)
    if (!pool) return false
    return pool.tierAccess.includes(tier)
  }

  /** Get all pools accessible to a tier. */
  resolveForTier(tier: Tier): PoolDefinition[] {
    const result: PoolDefinition[] = []
    for (const pool of this.pools.values()) {
      if (pool.tierAccess.includes(tier)) {
        result.push(pool)
      }
    }
    return result
  }

  /**
   * Validate that all values in model_preferences are valid pool IDs.
   * Returns validation result with errors for any invalid pool references.
   */
  validatePreferences(prefs: Record<string, string>): PoolValidationResult {
    const errors: string[] = []
    for (const [key, poolId] of Object.entries(prefs)) {
      if (!this.pools.has(poolId)) {
        errors.push(`model_preferences.${key}: unknown pool "${poolId}"`)
      }
    }
    return { valid: errors.length === 0, errors }
  }

  /**
   * Resolve the best pool for a request, following the resolution chain:
   * 1. NFT preferences (if provided)
   * 2. Tier default
   * 3. Global fallback
   *
   * If the resolved pool's provider is marked unhealthy, follows fallback chain.
   */
  resolveWithFallback(
    poolId: string,
    isHealthy: (provider: string, model: string) => boolean,
  ): PoolDefinition | null {
    const visited = new Set<string>()
    let current = poolId

    while (current && !visited.has(current)) {
      visited.add(current)
      const pool = this.pools.get(current)
      if (!pool) return null

      if (isHealthy(pool.provider, pool.model)) {
        return pool
      }

      if (!pool.fallback) return null
      current = pool.fallback
    }

    return null // circular or exhausted
  }

  /** Get all registered pool IDs. */
  getPoolIds(): string[] {
    return Array.from(this.pools.keys())
  }

  /** Get pool count. */
  get size(): number {
    return this.pools.size
  }

  // --- Private ---

  private detectCycle(startId: string): void {
    const visited = new Set<string>()
    let current: string | undefined = startId

    while (current) {
      if (visited.has(current)) {
        throw new Error(`Circular fallback chain detected: ${Array.from(visited).join(" → ")} → ${current}`)
      }
      visited.add(current)
      const pool = this.pools.get(current)
      current = pool?.fallback
    }
  }
}
