// src/hounfour/router.ts — Central model routing (SDD §4.2, T-15.1)

import { randomUUID } from "node:crypto"
import { HounfourError } from "./errors.js"
import { validateCapabilities } from "./registry.js"
import type { ProviderRegistry } from "./registry.js"
import type { BudgetEnforcer } from "./budget.js"
import type { ProviderRateLimiter } from "./rate-limiter.js"
import type { ChevalInvoker, HealthProber } from "./cheval-invoker.js"
import { createModelAdapter } from "./cheval-invoker.js"
import { loadPersona } from "./persona-loader.js"
import { validateExecutionContext } from "./types.js"
import type { PoolRegistry } from "./pool-registry.js"
import type { TenantContext } from "./jwt-auth.js"
import { selectAuthorizedPool } from "./pool-enforcement.js"
import type { BYOKProxyClient } from "./byok-proxy-client.js"
import type {
  AgentBinding,
  AgentRequirements,
  CompletionRequest,
  CompletionResult,
  ExecutionContext,
  CanonicalMessage,
  ToolCall,
  ToolDefinition,
  ModelCapabilities,
  ModelPortBase,
  ProviderEntry,
  PricingEntry,
  ResolvedModel,
  RoutingConfig,
  ScopeMeta,
  ProviderHealthSnapshot,
  BudgetSnapshot,
} from "./types.js"

// --- Router Options ---

export interface HounfourRouterOptions {
  registry: ProviderRegistry
  budget: BudgetEnforcer
  health: HealthProber
  cheval: ChevalInvoker
  scopeMeta: ScopeMeta
  rateLimiter?: ProviderRateLimiter     // Optional: per-provider RPM/TPM enforcement (T-16.3)
  poolRegistry?: PoolRegistry           // Optional: pool-based routing (T-C.1)
  byokProxy?: BYOKProxyClient           // Optional: BYOK proxy adapter (T-C.2)
  projectRoot?: string                  // For persona path resolution
  routingConfig?: Partial<RoutingConfig>
  toolCallConfig?: Partial<ToolCallLoopConfig>
}

export interface ToolCallLoopConfig {
  maxIterations: number             // Default: 20
  abortOnConsecutiveFailures: number // Default: 3
  maxWallTimeMs: number             // Default: 120000
  maxTotalToolCalls: number         // Default: 50
  budgetCheckPerIteration: boolean  // Default: true
}

const DEFAULT_TOOL_CALL_CONFIG: ToolCallLoopConfig = {
  maxIterations: 20,
  abortOnConsecutiveFailures: 3,
  maxWallTimeMs: 120_000,
  maxTotalToolCalls: 50,
  budgetCheckPerIteration: true,
}

/** Maximum time (ms) budget state can be unknown before circuit opens (5 minutes) */
const MAX_UNKNOWN_BUDGET_WINDOW = 300_000

export interface InvokeOptions {
  temperature?: number
  max_tokens?: number
  tool_choice?: "auto" | "required" | "none"
  systemPrompt?: string           // Injected as first system message (persona)
}

// --- Resolved Execution ---

interface ResolvedExecution {
  mode: "native_runtime" | "remote_model"
  model: ResolvedModel
  provider: ProviderEntry
}

// --- WalkChain Options ---

interface WalkChainOptions {
  chain: string[]
  original: ResolvedModel
  agent: string
  requires: AgentRequirements
  registry: ProviderRegistry
  disabledProviders: string[]
  health: HealthProber
  requireHealthy: boolean
  visited: Set<string>
  chainType: "fallback" | "downgrade"
}

// --- Tool Executor ---

export interface ToolExecutor {
  exec(tool: string, args: unknown): Promise<unknown>
}

// --- HounfourRouter ---

export class HounfourRouter {
  private registry: ProviderRegistry
  private budget: BudgetEnforcer
  private health: HealthProber
  private cheval: ChevalInvoker
  private scopeMeta: ScopeMeta
  private rateLimiter?: ProviderRateLimiter
  private poolRegistry?: PoolRegistry
  private byokProxy?: BYOKProxyClient
  private projectRoot: string
  private routingConfig: RoutingConfig
  private toolCallConfig: ToolCallLoopConfig

  constructor(options: HounfourRouterOptions) {
    this.registry = options.registry
    this.budget = options.budget
    this.health = options.health
    this.cheval = options.cheval
    this.scopeMeta = options.scopeMeta
    this.rateLimiter = options.rateLimiter
    this.poolRegistry = options.poolRegistry
    this.byokProxy = options.byokProxy
    this.projectRoot = options.projectRoot ?? process.cwd()
    this.routingConfig = {
      default_model: options.routingConfig?.default_model ?? "",
      on_budget_exceeded: options.routingConfig?.on_budget_exceeded ?? "block",
      fallback: options.routingConfig?.fallback ?? {},
      downgrade: options.routingConfig?.downgrade ?? {},
      disabled_providers: options.routingConfig?.disabled_providers ?? [],
      health: options.routingConfig?.health ?? {
        interval_ms: 60_000,
        timeout_ms: 5_000,
        failure_threshold: 3,
        recovery_interval_ms: 30_000,
      },
    }
    this.toolCallConfig = { ...DEFAULT_TOOL_CALL_CONFIG, ...options.toolCallConfig }
  }

  /**
   * Core dispatch — resolves binding, applies routing, invokes cheval.
   * Records cost and health after completion.
   */
  async invoke(agent: string, prompt: string, options?: InvokeOptions): Promise<CompletionResult> {
    const binding = this.registry.getAgentBinding(agent)
    if (!binding) {
      throw new HounfourError("BINDING_INVALID", `Agent "${agent}" not found in registry`, { agent })
    }

    const resolved = this.resolveExecution(agent, binding)
    const pricing = this.registry.getPricing(resolved.model.provider, resolved.model.modelId)
    if (!pricing) {
      throw new HounfourError("CONFIG_INVALID", `No pricing configured for ${resolved.model.provider}:${resolved.model.modelId}`, {
        provider: resolved.model.provider,
        model: resolved.model.modelId,
      })
    }

    const ctx: ExecutionContext = {
      resolved: resolved.model,
      scopeMeta: this.scopeMeta,
      binding,
      pricing,
    }
    validateExecutionContext(ctx)

    // Budget circuit breaker: reject if ledger writes have been failing too long
    if (this.budget.isBudgetCircuitOpen(MAX_UNKNOWN_BUDGET_WINDOW)) {
      throw new HounfourError("BUDGET_CIRCUIT_OPEN",
        `Budget ledger writes failing for >${MAX_UNKNOWN_BUDGET_WINDOW / 1000}s — circuit open`, {
          agent,
          maxUnknownMs: MAX_UNKNOWN_BUDGET_WINDOW,
        })
    }

    // Budget warning check
    if (this.budget.isWarning(this.scopeMeta)) {
      const snapshot = this.budget.getBudgetSnapshot(this.scopeMeta)
      console.warn(`[hounfour] Budget warning: ${snapshot.percent_used.toFixed(1)}% used (${snapshot.scope})`)
    }

    // Budget enforcement
    if (this.budget.isExceeded(this.scopeMeta)) {
      if (this.routingConfig.on_budget_exceeded === "block") {
        throw new HounfourError("BUDGET_EXCEEDED", `Budget exceeded for agent "${agent}"`, {
          agent,
          snapshot: this.budget.getBudgetSnapshot(this.scopeMeta),
        })
      }
      // downgrade path handled in resolveExecution
    }

    // Load persona (if configured) and build messages
    const persona = await loadPersona(binding, this.projectRoot)
    const effectiveOptions = persona && !options?.systemPrompt
      ? { ...options, systemPrompt: persona }
      : options
    const messages = this.buildMessages(prompt, effectiveOptions)
    const traceId = randomUUID()
    const request: CompletionRequest = {
      messages,
      options: {
        temperature: options?.temperature ?? binding.temperature,
        max_tokens: options?.max_tokens,
      },
      metadata: {
        agent,
        tenant_id: "local",
        nft_id: "",
        trace_id: traceId,
      },
    }

    // Rate limit enforcement (T-16.3) — acquire before invoking provider
    if (this.rateLimiter) {
      const estimatedTokens = options?.max_tokens ?? 4096
      const acquired = await this.rateLimiter.acquire(resolved.model.provider, estimatedTokens)
      if (!acquired) {
        throw new HounfourError("RATE_LIMITED", `Rate limit timeout for provider "${resolved.model.provider}"`, {
          agent,
          provider: resolved.model.provider,
        })
      }
    }

    // Create adapter and invoke
    const adapter = createModelAdapter(resolved.model, resolved.provider, this.cheval, this.health)
    const result = await adapter.complete(request)

    // Record cost
    await this.budget.recordCost(this.scopeMeta, result.usage, pricing, {
      trace_id: traceId,
      agent,
      provider: resolved.model.provider,
      model: resolved.model.modelId,
      tenant_id: "local",
      latency_ms: result.metadata.latency_ms,
    })

    return result
  }

  /**
   * Tenant-aware dispatch — resolves model via NFT preferences and pool registry.
   * Uses TenantContext from JWT claims to route per-NFT model preferences.
   * If BYOK flag is set, delegates to BYOKProxyClient instead of direct provider.
   *
   * Resolution order: (1) NFT preferences per task type → (2) tier default → (3) global fallback
   */
  async invokeForTenant(
    agent: string,
    prompt: string,
    tenantContext: TenantContext,
    taskType: string,
    options?: InvokeOptions,
  ): Promise<CompletionResult> {
    if (!this.poolRegistry) {
      throw new HounfourError("CONFIG_INVALID", "PoolRegistry required for tenant-aware routing", { agent })
    }

    const binding = this.registry.getAgentBinding(agent)
    if (!binding) {
      throw new HounfourError("BINDING_INVALID", `Agent "${agent}" not found in registry`, { agent })
    }

    // Pool selection via single choke point (SDD §3.5.2)
    const poolId = selectAuthorizedPool(tenantContext, taskType)

    // Resolve pool with health-aware fallback
    const pool = this.poolRegistry.resolveWithFallback(
      poolId,
      (provider, model) => this.health.isHealthy({ provider, modelId: model }),
    )
    if (!pool) {
      throw new HounfourError("PROVIDER_UNAVAILABLE",
        `No healthy provider for pool "${poolId}" (fallback chain exhausted)`, {
          agent, pool: poolId,
        })
    }

    // Build tenant-aware metadata
    const traceId = randomUUID()
    const tenantId = tenantContext.claims.tenant_id
    const nftId = tenantContext.claims.nft_id ?? ""

    // Budget circuit breaker
    if (this.budget.isBudgetCircuitOpen(MAX_UNKNOWN_BUDGET_WINDOW)) {
      throw new HounfourError("BUDGET_CIRCUIT_OPEN",
        `Budget ledger writes failing for >${MAX_UNKNOWN_BUDGET_WINDOW / 1000}s — circuit open`, {
          agent, tenant_id: tenantId,
          maxUnknownMs: MAX_UNKNOWN_BUDGET_WINDOW,
        })
    }

    // Budget enforcement
    if (this.budget.isExceeded(this.scopeMeta)) {
      throw new HounfourError("BUDGET_EXCEEDED", `Budget exceeded for tenant "${tenantId}"`, {
        agent, tenant_id: tenantId,
      })
    }

    // Load persona and build messages
    const persona = await loadPersona(binding, this.projectRoot)
    const effectiveOptions = persona && !options?.systemPrompt
      ? { ...options, systemPrompt: persona }
      : options
    const messages = this.buildMessages(prompt, effectiveOptions)

    const request: CompletionRequest = {
      messages,
      options: {
        temperature: options?.temperature ?? binding.temperature,
        max_tokens: options?.max_tokens,
      },
      metadata: {
        agent,
        tenant_id: tenantId,
        nft_id: nftId,
        trace_id: traceId,
      },
    }

    // Choose execution path: BYOK proxy vs direct provider
    let adapter: ModelPortBase
    if (tenantContext.isBYOK) {
      if (!this.byokProxy) {
        throw new HounfourError("BYOK_PROXY_UNAVAILABLE", "BYOK proxy is not configured", {
          agent,
          tenant_id: tenantId,
          nft_id: nftId,
        })
      }
      adapter = this.byokProxy
    } else {
      const resolved: ResolvedModel = { provider: pool.provider, modelId: pool.model }
      const providerEntry = this.registry.getProvider(pool.provider)
      if (!providerEntry) {
        throw new HounfourError("PROVIDER_UNAVAILABLE", `Provider "${pool.provider}" not found`, {
          agent, provider: pool.provider,
        })
      }
      adapter = createModelAdapter(resolved, providerEntry, this.cheval, this.health)
    }

    // Rate limit enforcement
    if (this.rateLimiter) {
      const estimatedTokens = options?.max_tokens ?? 4096
      const acquired = await this.rateLimiter.acquire(pool.provider, estimatedTokens)
      if (!acquired) {
        throw new HounfourError("RATE_LIMITED", `Rate limit timeout for provider "${pool.provider}"`, {
          agent, provider: pool.provider,
        })
      }
    }

    const result = await adapter.complete(request)

    // Record cost with pool and tenant attribution
    const pricing = this.registry.getPricing(pool.provider, pool.model)
    if (pricing) {
      await this.budget.recordCost(this.scopeMeta, result.usage, pricing, {
        trace_id: traceId,
        agent,
        provider: pool.provider,
        model: pool.model,
        tenant_id: tenantId,
        nft_id: nftId || undefined,
        pool_id: pool.id,
        latency_ms: result.metadata.latency_ms,
      })
    }

    return result
  }

  /**
   * Tool-call loop — orchestrates multi-turn tool execution.
   * Returns final CompletionResult after loop terminates (no more tool calls,
   * max iterations, or error).
   */
  async invokeWithTools(
    agent: string,
    prompt: string,
    tools: ToolDefinition[],
    executor: ToolExecutor,
    options?: InvokeOptions,
  ): Promise<CompletionResult> {
    const binding = this.registry.getAgentBinding(agent)
    if (!binding) {
      throw new HounfourError("BINDING_INVALID", `Agent "${agent}" not found in registry`, { agent })
    }

    const resolved = this.resolveExecution(agent, binding)
    const pricing = this.registry.getPricing(resolved.model.provider, resolved.model.modelId)
    if (!pricing) {
      throw new HounfourError("CONFIG_INVALID", `No pricing configured for ${resolved.model.provider}:${resolved.model.modelId}`, {
        provider: resolved.model.provider,
        model: resolved.model.modelId,
      })
    }

    const ctx: ExecutionContext = {
      resolved: resolved.model,
      scopeMeta: this.scopeMeta,
      binding,
      pricing,
    }
    validateExecutionContext(ctx)

    const model = this.registry.getModel(resolved.model.provider, resolved.model.modelId)
    const contextLimit = model?.limit.context ?? 128_000

    // Budget circuit breaker (pre-loop)
    if (this.budget.isBudgetCircuitOpen(MAX_UNKNOWN_BUDGET_WINDOW)) {
      throw new HounfourError("BUDGET_CIRCUIT_OPEN",
        `Budget ledger writes failing for >${MAX_UNKNOWN_BUDGET_WINDOW / 1000}s — circuit open`, {
          agent,
          maxUnknownMs: MAX_UNKNOWN_BUDGET_WINDOW,
        })
    }

    // Load persona (if configured) and build messages
    const persona = await loadPersona(binding, this.projectRoot)
    const effectiveOptions = persona && !options?.systemPrompt
      ? { ...options, systemPrompt: persona }
      : options

    const traceId = randomUUID()
    const messages: CanonicalMessage[] = this.buildMessages(prompt, effectiveOptions)
    const adapter = createModelAdapter(resolved.model, resolved.provider, this.cheval, this.health)
    const idempotencyCache = new Map<string, CanonicalMessage & { role: "tool" }>()

    let consecutiveFailures = 0
    let totalToolCalls = 0
    let cumulativePromptTokens = 0
    const startTime = Date.now()

    for (let iteration = 0; iteration < this.toolCallConfig.maxIterations; iteration++) {
      // Budget check per iteration (includes circuit breaker re-check)
      if (this.budget.isBudgetCircuitOpen(MAX_UNKNOWN_BUDGET_WINDOW)) {
        throw new HounfourError("BUDGET_CIRCUIT_OPEN",
          `Budget circuit opened mid-loop at iteration ${iteration + 1}`, {
            agent, iteration: iteration + 1,
            maxUnknownMs: MAX_UNKNOWN_BUDGET_WINDOW,
          })
      }
      if (this.toolCallConfig.budgetCheckPerIteration && this.budget.isExceeded(this.scopeMeta)) {
        throw new HounfourError("BUDGET_EXCEEDED", `Budget exceeded mid-loop at iteration ${iteration + 1}`, {
          agent,
          iteration: iteration + 1,
        })
      }

      // Wall time check
      if (Date.now() - startTime > this.toolCallConfig.maxWallTimeMs) {
        throw new HounfourError("TOOL_CALL_WALL_TIME_EXCEEDED", `Wall time exceeded at iteration ${iteration + 1}`, {
          agent,
          iteration: iteration + 1,
          wallTimeMs: Date.now() - startTime,
        })
      }

      // Context budget check
      const contextUtilization = contextLimit > 0 ? cumulativePromptTokens / contextLimit : 0
      if (contextUtilization >= 0.9) {
        throw new HounfourError("CONTEXT_OVERFLOW", `Context budget exceeded: ${Math.round(contextUtilization * 100)}%`, {
          agent,
          cumulativeTokens: cumulativePromptTokens,
          contextLimit,
          iteration: iteration + 1,
        })
      } else if (contextUtilization >= 0.8) {
        console.warn(
          `[hounfour] Context budget warning: ${Math.round(contextUtilization * 100)}% ` +
          `(${cumulativePromptTokens}/${contextLimit} tokens) at iteration ${iteration + 1}`,
        )
      }

      // Rate limit enforcement per iteration (T-16.3)
      if (this.rateLimiter) {
        const estimatedTokens = options?.max_tokens ?? 4096
        const acquired = await this.rateLimiter.acquire(resolved.model.provider, estimatedTokens)
        if (!acquired) {
          throw new HounfourError("RATE_LIMITED", `Rate limit timeout at iteration ${iteration + 1}`, {
            agent,
            provider: resolved.model.provider,
            iteration: iteration + 1,
          })
        }
      }

      // Invoke
      const request: CompletionRequest = {
        messages: [...messages],
        tools,
        options: {
          temperature: options?.temperature ?? binding.temperature,
          max_tokens: options?.max_tokens,
          tool_choice: options?.tool_choice ?? "auto",
        },
        metadata: {
          agent,
          tenant_id: "local",
          nft_id: "",
          trace_id: traceId,
        },
      }

      const result = await adapter.complete(request)
      cumulativePromptTokens += result.usage.prompt_tokens

      // Record cost per iteration
      await this.budget.recordCost(this.scopeMeta, result.usage, pricing, {
        trace_id: traceId,
        agent,
        provider: resolved.model.provider,
        model: resolved.model.modelId,
        tenant_id: "local",
        latency_ms: result.metadata.latency_ms,
      })

      // No tool calls — return final content
      if (!result.tool_calls || result.tool_calls.length === 0) {
        return result
      }

      // Total tool call limit
      totalToolCalls += result.tool_calls.length
      if (totalToolCalls > this.toolCallConfig.maxTotalToolCalls) {
        throw new HounfourError("TOOL_CALL_LIMIT_EXCEEDED", `Total tool calls exceeded limit: ${totalToolCalls}`, {
          agent,
          totalToolCalls,
          limit: this.toolCallConfig.maxTotalToolCalls,
        })
      }

      // Process each tool call
      const toolResults: (CanonicalMessage & { role: "tool" })[] = []
      for (const toolCall of result.tool_calls) {
        const cacheKey = `${traceId}:${toolCall.id}`

        // Idempotency check
        if (idempotencyCache.has(cacheKey)) {
          toolResults.push(idempotencyCache.get(cacheKey)!)
          continue
        }

        // Parse arguments
        let parsedArgs: unknown
        try {
          parsedArgs = JSON.parse(toolCall.function.arguments)
        } catch (parseErr) {
          // Repair strategy: feed parse error back, model gets one retry
          const errorResult: CanonicalMessage & { role: "tool" } = {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ is_error: true, error: `Malformed JSON: ${(parseErr as Error).message}` }),
          }
          toolResults.push(errorResult)
          consecutiveFailures++
          continue
        }

        // Execute tool
        try {
          const execResult = await executor.exec(toolCall.function.name, parsedArgs)
          const successResult: CanonicalMessage & { role: "tool" } = {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(execResult),
          }
          toolResults.push(successResult)
          idempotencyCache.set(cacheKey, successResult)
          consecutiveFailures = 0
        } catch (execErr) {
          const errorResult: CanonicalMessage & { role: "tool" } = {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ is_error: true, error: (execErr as Error).message }),
          }
          toolResults.push(errorResult)
          idempotencyCache.set(cacheKey, errorResult)
          consecutiveFailures++
        }
      }

      // Abort on consecutive failures
      if (consecutiveFailures >= this.toolCallConfig.abortOnConsecutiveFailures) {
        throw new HounfourError("TOOL_CALL_CONSECUTIVE_FAILURES", `${consecutiveFailures} consecutive tool failures`, {
          agent,
          consecutiveFailures,
          iteration: iteration + 1,
        })
      }

      // Append assistant message + tool results to conversation
      messages.push({
        role: "assistant",
        content: result.content || null,
        tool_calls: result.tool_calls,
      })
      messages.push(...toolResults)
    }

    throw new HounfourError("TOOL_CALL_MAX_ITERATIONS", `Max iterations (${this.toolCallConfig.maxIterations}) exceeded`, {
      agent,
      maxIterations: this.toolCallConfig.maxIterations,
    })
  }

  /** Validate all agent bindings at startup */
  validateBindings(): void {
    const results = this.registry.validateBindings()
    const failures = results.filter(r => !r.valid)
    if (failures.length > 0) {
      const details = failures.map(f => `  ${f.agent}: ${f.errors.join(", ")}`).join("\n")
      throw new HounfourError("BINDING_INVALID", `${failures.length} binding validation failures:\n${details}`, {
        failures,
      })
    }
  }

  /** Health snapshot for HealthAggregator */
  healthSnapshot(): ProviderHealthSnapshot {
    const providers: ProviderHealthSnapshot["providers"] = {}
    for (const p of this.registry.listProviders()) {
      const models: Record<string, { healthy: boolean; latency_ms: number }> = {}
      for (const [modelId] of p.models) {
        const healthy = this.health.isHealthy({ provider: p.name, modelId })
        models[modelId] = { healthy, latency_ms: 0 }
      }
      providers[p.name] = {
        healthy: Object.values(models).every(m => m.healthy),
        models,
      }
    }
    return { providers }
  }

  /** Budget snapshot for dashboard */
  budgetSnapshot(): BudgetSnapshot {
    return this.budget.getBudgetSnapshot(this.scopeMeta)
  }

  // --- Private helpers ---

  /**
   * Resolve agent → model binding with routing rules.
   * Implements: alias resolution → capability check → budget downgrade → availability fallback
   */
  private resolveExecution(agent: string, binding: AgentBinding): ResolvedExecution {
    const resolved = this.registry.resolveAlias(binding.model)
    const provider = this.registry.getProvider(resolved.provider)

    if (!provider) {
      throw new HounfourError("PROVIDER_UNAVAILABLE", `Provider "${resolved.provider}" not found`, {
        agent,
        provider: resolved.provider,
      })
    }

    // Determine execution mode
    const mode = provider.type === "claude-code" ? "native_runtime" as const : "remote_model" as const

    // Hard fail: native_runtime required but not available
    if (binding.requires.native_runtime && mode !== "native_runtime") {
      throw new HounfourError("NATIVE_RUNTIME_REQUIRED", `Agent "${agent}" requires native_runtime but bound to ${provider.type}`, {
        agent,
        providerType: provider.type,
      })
    }

    // Capability check
    const model = this.registry.getModel(resolved.provider, resolved.modelId)
    if (!model) {
      throw new HounfourError("CONFIG_INVALID", `Model "${resolved.modelId}" not found in provider "${resolved.provider}"`, {
        agent,
        provider: resolved.provider,
        model: resolved.modelId,
      })
    }

    const capCheck = validateCapabilities(model.capabilities, binding.requires)
    if (!capCheck.valid) {
      throw new HounfourError("BINDING_INVALID", `Capability mismatch for agent "${agent}": missing ${capCheck.missing.join(", ")}`, {
        agent,
        missing: capCheck.missing,
      })
    }

    // Track visited models for cycle prevention across downgrade+fallback
    const visited = new Set<string>([`${resolved.provider}:${resolved.modelId}`])
    let effectiveModel = resolved

    // Budget downgrade (cost pressure)
    if (this.budget.isExceeded(this.scopeMeta) && this.routingConfig.on_budget_exceeded === "downgrade") {
      const canonicalKey = `${resolved.provider}:${resolved.modelId}`
      const downgradeChain = this.routingConfig.downgrade[canonicalKey] ?? []
      if (downgradeChain.length > 0) {
        effectiveModel = walkChain({
          chain: downgradeChain,
          original: resolved,
          agent,
          requires: binding.requires,
          registry: this.registry,
          disabledProviders: this.routingConfig.disabled_providers,
          health: this.health,
          requireHealthy: false, // Downgrade accepts unhealthy to reduce cost
          visited,
          chainType: "downgrade",
        })
      }
    }

    // Availability fallback (provider health)
    if (!this.health.isHealthy(effectiveModel)) {
      const canonicalKey = `${effectiveModel.provider}:${effectiveModel.modelId}`
      const fallbackChain = this.routingConfig.fallback[canonicalKey] ?? []
      if (fallbackChain.length > 0) {
        effectiveModel = walkChain({
          chain: fallbackChain,
          original: effectiveModel,
          agent,
          requires: binding.requires,
          registry: this.registry,
          disabledProviders: this.routingConfig.disabled_providers,
          health: this.health,
          requireHealthy: true,
          visited,
          chainType: "fallback",
        })
      } else {
        throw new HounfourError("PROVIDER_UNAVAILABLE", `Provider ${effectiveModel.provider}:${effectiveModel.modelId} is unhealthy with no fallback`, {
          agent,
          provider: effectiveModel.provider,
          model: effectiveModel.modelId,
        })
      }
    }

    const effectiveProvider = this.registry.getProvider(effectiveModel.provider)!
    return { mode, model: effectiveModel, provider: effectiveProvider }
  }

  private buildMessages(prompt: string, options?: InvokeOptions): CanonicalMessage[] {
    const messages: CanonicalMessage[] = []
    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt })
    }
    messages.push({ role: "user", content: prompt })
    return messages
  }
}

// --- walkChain ---

function walkChain(options: WalkChainOptions): ResolvedModel {
  const {
    chain, original, agent, requires, registry,
    disabledProviders, health, requireHealthy, visited, chainType,
  } = options

  const rejectionReasons: Array<{ candidate: string; reason: string }> = []

  for (const candidate of chain) {
    let resolved: ResolvedModel
    try {
      resolved = registry.resolveAlias(candidate)
    } catch {
      rejectionReasons.push({ candidate, reason: "cannot resolve alias" })
      continue
    }

    const canonicalKey = `${resolved.provider}:${resolved.modelId}`

    // Cycle prevention
    if (visited.has(canonicalKey)) {
      rejectionReasons.push({ candidate, reason: "already visited (cycle prevention)" })
      continue
    }

    // Skip disabled providers
    if (disabledProviders.includes(resolved.provider)) {
      rejectionReasons.push({ candidate, reason: `provider disabled: ${resolved.provider}` })
      continue
    }

    // Capability check
    const model = registry.getModel(resolved.provider, resolved.modelId)
    if (!model) {
      rejectionReasons.push({ candidate, reason: "model not found in registry" })
      continue
    }

    const capCheck = validateCapabilities(model.capabilities, requires)
    if (!capCheck.valid) {
      rejectionReasons.push({ candidate, reason: `capability mismatch: ${capCheck.missing.join(", ")}` })
      continue
    }

    // Native runtime enforcement — chain candidates must match provider type (T-16.4)
    if (requires.native_runtime) {
      const candidateProvider = registry.getProvider(resolved.provider)
      if (!candidateProvider || candidateProvider.type !== "claude-code") {
        rejectionReasons.push({ candidate, reason: "native_runtime required but provider is not claude-code" })
        continue
      }
    }

    // Health check (only for fallback mode)
    if (requireHealthy && !health.isHealthy(resolved)) {
      rejectionReasons.push({ candidate, reason: "provider unhealthy" })
      continue
    }

    visited.add(canonicalKey)
    return resolved
  }

  // Chain exhausted
  throw new HounfourError("PROVIDER_UNAVAILABLE",
    `${chainType} chain exhausted for agent "${agent}" (original: ${original.provider}:${original.modelId})`, {
      agent,
      original: `${original.provider}:${original.modelId}`,
      chainType,
      attempted: chain,
      rejections: rejectionReasons,
    },
  )
}
