// src/hounfour/registry.ts — Immutable provider registry (SDD §4.1, T-14.3)

import { HounfourError } from "./errors.js"
import type {
  ProviderEntry,
  ProviderOptions,
  ModelEntry,
  ModelCapabilities,
  AgentBinding,
  AgentRequirements,
  ResolvedModel,
  RetryPolicy,
  ValidationResult,
  PricingEntry,
} from "./types.js"

/** Allowlist patterns for {env:VAR} interpolation */
const ENV_ALLOWLIST_PATTERNS = [
  /^[A-Z_]+_API_KEY$/,   // *_API_KEY
  /^CHEVAL_/,            // CHEVAL_*
]

function isEnvVarAllowed(name: string): boolean {
  return ENV_ALLOWLIST_PATTERNS.some(p => p.test(name))
}

/** Resolve {env:VAR_NAME} patterns in a string */
function interpolateEnvVar(value: string): string {
  const match = value.match(/^\{env:([^}]+)\}$/)
  if (!match) return value
  const varName = match[1]
  if (!isEnvVarAllowed(varName)) {
    console.warn(`[hounfour] WARN: Env var "${varName}" does not match allowlist pattern. Rejecting interpolation.`)
    return ""
  }
  return process.env[varName] ?? ""
}

/** Raw config shape from YAML (before validation/resolution) */
export interface RawProviderConfig {
  providers: Record<string, RawProviderEntry>
  aliases?: Record<string, string>
  agents?: Record<string, RawAgentBinding>
  routing?: RawRoutingConfig
  pricing?: Record<string, RawPricingEntry>
}

interface RawProviderEntry {
  type: "claude-code" | "openai" | "openai-compatible"
  enabled?: boolean
  options?: {
    baseURL?: string
    apiKey?: string
    connectTimeoutMs?: number
    readTimeoutMs?: number
    totalTimeoutMs?: number
  }
  models: Record<string, RawModelEntry>
  retryPolicy?: RetryPolicy
}

interface RawModelEntry {
  name: string
  capabilities: ModelCapabilities
  limit: { context: number; output: number }
  defaults?: { temperature?: number; top_p?: number }
}

interface RawAgentBinding {
  model: string
  temperature?: number
  persona?: string
  requires: AgentRequirements
}

interface RawRoutingConfig {
  fallback?: Record<string, string[]>
  downgrade?: Record<string, string[]>
}

interface RawPricingEntry {
  input_per_1m: number
  output_per_1m: number
  reasoning_per_1m?: number
}

export class ProviderRegistry {
  private providers: Map<string, ProviderEntry>
  private aliases: Map<string, string>
  private agents: Map<string, AgentBinding>
  private pricing: Map<string, PricingEntry>

  private constructor(
    providers: Map<string, ProviderEntry>,
    aliases: Map<string, string>,
    agents: Map<string, AgentBinding>,
    pricing: Map<string, PricingEntry>,
  ) {
    this.providers = providers
    this.aliases = aliases
    this.agents = agents
    this.pricing = pricing
  }

  /** Factory — resolves {env:VAR} interpolation, validates schema */
  static fromConfig(raw: RawProviderConfig): ProviderRegistry {
    const providers = new Map<string, ProviderEntry>()
    const aliases = new Map<string, string>()
    const agents = new Map<string, AgentBinding>()
    const pricing = new Map<string, PricingEntry>()

    // Parse providers
    for (const [name, rawProvider] of Object.entries(raw.providers)) {
      if (rawProvider.enabled === false) continue

      const options: ProviderOptions = {}
      if (rawProvider.options) {
        options.baseURL = rawProvider.options.baseURL
        options.apiKey = rawProvider.options.apiKey
          ? interpolateEnvVar(rawProvider.options.apiKey)
          : undefined
        options.connectTimeoutMs = rawProvider.options.connectTimeoutMs
        options.readTimeoutMs = rawProvider.options.readTimeoutMs
        options.totalTimeoutMs = rawProvider.options.totalTimeoutMs
      }

      const models = new Map<string, ModelEntry>()
      for (const [modelId, rawModel] of Object.entries(rawProvider.models)) {
        models.set(modelId, {
          id: modelId,
          name: rawModel.name,
          capabilities: rawModel.capabilities,
          limit: rawModel.limit,
          defaults: rawModel.defaults,
        })
      }

      providers.set(name, {
        name,
        type: rawProvider.type,
        options,
        models,
        retryPolicy: rawProvider.retryPolicy,
      })
    }

    // Parse aliases
    if (raw.aliases) {
      for (const [alias, canonical] of Object.entries(raw.aliases)) {
        aliases.set(alias, canonical)
      }
    }

    // Parse agent bindings
    if (raw.agents) {
      for (const [agentName, rawBinding] of Object.entries(raw.agents)) {
        agents.set(agentName, {
          agent: agentName,
          model: rawBinding.model,
          temperature: rawBinding.temperature,
          persona: rawBinding.persona,
          requires: rawBinding.requires,
        })
      }
    }

    // Parse pricing
    if (raw.pricing) {
      for (const [key, rawPricing] of Object.entries(raw.pricing)) {
        pricing.set(key, {
          provider: key.split(":")[0],
          model: key.split(":")[1] ?? key,
          input_per_1m: rawPricing.input_per_1m,
          output_per_1m: rawPricing.output_per_1m,
          reasoning_per_1m: rawPricing.reasoning_per_1m,
        })
      }
    }

    // Validate fallback/downgrade chains for cycles
    if (raw.routing) {
      const allChains: Record<string, string[]> = {
        ...raw.routing.fallback,
        ...raw.routing.downgrade,
      }
      detectCycles(allChains, aliases)
    }

    return new ProviderRegistry(providers, aliases, agents, pricing)
  }

  /** Resolve alias to canonical provider:model */
  resolveAlias(aliasOrCanonical: string): ResolvedModel {
    const canonical = this.aliases.get(aliasOrCanonical) ?? aliasOrCanonical
    const parts = canonical.split(":")
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new HounfourError("CONFIG_INVALID", `Cannot resolve "${aliasOrCanonical}" to provider:model`, {
        input: aliasOrCanonical,
        resolved: canonical,
      })
    }
    return { provider: parts[0], modelId: parts[1] }
  }

  /** Get provider entry */
  getProvider(name: string): ProviderEntry | undefined {
    return this.providers.get(name)
  }

  /** Get model entry */
  getModel(provider: string, modelId: string): ModelEntry | undefined {
    return this.providers.get(provider)?.models.get(modelId)
  }

  /** Get agent binding */
  getAgentBinding(agentName: string): AgentBinding | undefined {
    return this.agents.get(agentName)
  }

  /** Get pricing for a provider:model pair */
  getPricing(provider: string, modelId: string): PricingEntry | undefined {
    return this.pricing.get(`${provider}:${modelId}`)
  }

  /** List all enabled providers */
  listProviders(): ProviderEntry[] {
    return Array.from(this.providers.values())
  }

  /** Validate agent→model bindings against capabilities */
  validateBindings(): ValidationResult[] {
    const results: ValidationResult[] = []

    for (const [agentName, binding] of this.agents) {
      const errors: string[] = []

      // Resolve model alias
      let resolved: ResolvedModel
      try {
        resolved = this.resolveAlias(binding.model)
      } catch {
        errors.push(`Cannot resolve model "${binding.model}" to provider:model`)
        results.push({ valid: false, agent: agentName, model: binding.model, errors })
        continue
      }

      // Check provider exists
      const provider = this.providers.get(resolved.provider)
      if (!provider) {
        errors.push(`Provider "${resolved.provider}" not found or disabled`)
        results.push({ valid: false, agent: agentName, model: binding.model, errors })
        continue
      }

      // Check model exists
      const model = provider.models.get(resolved.modelId)
      if (!model) {
        errors.push(`Model "${resolved.modelId}" not found in provider "${resolved.provider}"`)
        results.push({ valid: false, agent: agentName, model: binding.model, errors })
        continue
      }

      // Check native_runtime requirement
      if (binding.requires.native_runtime && provider.type !== "claude-code") {
        errors.push(`Agent requires native_runtime but provider "${resolved.provider}" is type "${provider.type}"`)
      }

      // Check tool_calling capability
      if (binding.requires.tool_calling === true && !model.capabilities.tool_calling) {
        errors.push(`Agent requires tool_calling but model "${resolved.modelId}" does not support it`)
      }

      // Check thinking_traces capability
      if (binding.requires.thinking_traces === "required" && !model.capabilities.thinking_traces) {
        errors.push(`Agent requires thinking_traces but model "${resolved.modelId}" does not support it`)
      }

      results.push({
        valid: errors.length === 0,
        agent: agentName,
        model: binding.model,
        errors,
      })
    }

    return results
  }
}

/** Validate capabilities against agent requirements */
export function validateCapabilities(
  capabilities: ModelCapabilities,
  requires: AgentRequirements,
): { valid: boolean; missing: string[] } {
  const missing: string[] = []

  if (requires.tool_calling === true && !capabilities.tool_calling) {
    missing.push("tool_calling")
  }
  if (requires.thinking_traces === "required" && !capabilities.thinking_traces) {
    missing.push("thinking_traces")
  }

  return { valid: missing.length === 0, missing }
}

/** DFS cycle detection on fallback/downgrade chain graph */
function detectCycles(
  chains: Record<string, string[]>,
  aliases: Map<string, string>,
): void {
  const visiting = new Set<string>()
  const visited = new Set<string>()

  function resolveCanonical(aliasOrCanonical: string): string {
    return aliases.get(aliasOrCanonical) ?? aliasOrCanonical
  }

  function dfs(node: string): void {
    const canonical = resolveCanonical(node)
    if (visited.has(canonical)) return
    if (visiting.has(canonical)) {
      throw new HounfourError("CONFIG_INVALID", `Cycle detected in fallback/downgrade chain at "${canonical}"`, {
        node: canonical,
      })
    }

    visiting.add(canonical)
    const neighbors = chains[canonical] ?? chains[node] ?? []
    for (const neighbor of neighbors) {
      dfs(neighbor)
    }
    visiting.delete(canonical)
    visited.add(canonical)
  }

  for (const node of Object.keys(chains)) {
    dfs(node)
  }
}
