// src/hounfour/ensemble.ts — Ensemble Orchestrator (SDD §3.8, T-B.3)
// Runs same prompt against N models in parallel with configurable merge strategies.
// Two-level budget enforcement: per-model cap + total ensemble cap.
// AbortController hierarchy: parent → child per model.

import { ulid } from "ulid"
import type {
  CompletionRequest,
  CompletionResult,
  ExecutionContext,
  LedgerEntry,
  ModelPortBase,
  PricingEntry,
  UsageInfo,
} from "./types.js"
import type { UsageReport } from "./usage-reporter.js"
import { calculateCost } from "./budget.js"

// --- Types ---

export type MergeStrategy = "first_complete" | "best_of_n" | "consensus"

/** Async scorer function: receives a CompletionResult, returns 0.0-1.0 score */
export type ScorerFunction = (result: CompletionResult) => Promise<number>

export interface EnsembleConfig {
  /** Pool IDs for models to race */
  models: string[]
  /** Merge strategy */
  strategy: MergeStrategy
  /** Budget cap per individual model invocation (micro-USD) */
  budget_per_model_micro: number
  /** Total ensemble budget cap (micro-USD) — sum of all model costs */
  budget_total_micro: number
  /** Timeout per ensemble run (ms) */
  timeout_ms: number
  /** Scoring function for best_of_n — sync or async (default: token efficiency) */
  scorer?: ((result: CompletionResult) => number) | ScorerFunction
  /** Field extractor for consensus strategy (returns JSON object from content) */
  fieldExtractor?: (result: CompletionResult) => Record<string, unknown> | null
}

export interface EnsembleModelResult {
  pool: string
  result: CompletionResult | null
  error: string | null
  cost_micro: number
  latency_ms: number
}

export interface EnsembleResult {
  ensemble_id: string
  selected: CompletionResult
  all_results: EnsembleModelResult[]
  strategy_used: MergeStrategy
  total_cost_micro: number
}

/** Resolves a pool ID to a ModelPortBase adapter and its pricing */
export interface ModelResolver {
  resolve(pool: string): { adapter: ModelPortBase; pricing: PricingEntry }
}

// --- Default Scorer ---

/** Default scorer: prefer shorter, cheaper completions (token efficiency) */
function defaultSyncScorer(result: CompletionResult): number {
  const tokens = result.usage.completion_tokens || 1
  const contentLength = result.content.length || 1
  // Higher score = more content per token (efficient)
  return contentLength / tokens
}

/** Resolve scorer from config, wrapping sync scorers to async */
function resolveScorer(config: EnsembleConfig): ScorerFunction {
  if (!config.scorer) {
    return async (result: CompletionResult) => defaultSyncScorer(result)
  }
  // Wrap to always return Promise (handles both sync and async scorers)
  const fn = config.scorer
  return async (result: CompletionResult) => fn(result)
}

// --- EnsembleOrchestrator ---

export class EnsembleOrchestrator {
  private resolver: ModelResolver

  constructor(resolver: ModelResolver) {
    this.resolver = resolver
  }

  /**
   * Run an ensemble: dispatch request to N models, merge per strategy.
   */
  async run(
    request: CompletionRequest,
    config: EnsembleConfig,
    _context: ExecutionContext,
  ): Promise<EnsembleResult> {
    if (config.models.length === 0) {
      throw new Error("EnsembleOrchestrator: no models specified")
    }

    const ensembleId = ulid()
    const parentAbort = new AbortController()

    // Enforce total timeout
    const timeoutId = setTimeout(() => parentAbort.abort(), config.timeout_ms)

    try {
      switch (config.strategy) {
        case "first_complete":
          return await this.runFirstComplete(request, config, ensembleId, parentAbort)
        case "best_of_n":
          return await this.runBestOfN(request, config, ensembleId, parentAbort)
        case "consensus":
          return await this.runConsensus(request, config, ensembleId, parentAbort)
        default:
          throw new Error(`Unknown ensemble strategy: ${config.strategy}`)
      }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // --- first_complete ---

  /**
   * Race N models, return first non-error response.
   * Cancel all others via parent AbortController when first completes.
   */
  private async runFirstComplete(
    request: CompletionRequest,
    config: EnsembleConfig,
    ensembleId: string,
    parentAbort: AbortController,
  ): Promise<EnsembleResult> {
    const allResults: EnsembleModelResult[] = []
    const childAborts: AbortController[] = []

    const racePromises = config.models.map((pool) => {
      const childAbort = new AbortController()
      childAborts.push(childAbort)

      // Link parent → child
      parentAbort.signal.addEventListener("abort", () => childAbort.abort(), { once: true })

      return this.invokeModel(pool, request, config, childAbort)
    })

    // Use Promise.any semantics: first successful result wins
    // We implement this manually to track all results including failures
    return new Promise<EnsembleResult>((resolve, reject) => {
      let settled = false
      let completedCount = 0

      racePromises.forEach((promise, index) => {
        // invokeModel() never rejects (catches internally), so .then() handles all cases
        promise.then((modelResult) => {
          allResults[index] = modelResult

          if (!settled && modelResult.result && !modelResult.error) {
            settled = true
            // Cancel all other models
            parentAbort.abort()

            resolve({
              ensemble_id: ensembleId,
              selected: modelResult.result,
              all_results: allResults.filter(Boolean),
              strategy_used: "first_complete",
              total_cost_micro: modelResult.cost_micro, // Winner-only cost (others are cancelled)
            })
          }

          completedCount++
          if (!settled && completedCount === config.models.length) {
            // All models failed
            reject(new Error(`Ensemble first_complete: all ${config.models.length} models failed`))
          }
        })
      })
    })
  }

  // --- best_of_n ---

  /**
   * Run all models in parallel, score results, return highest.
   * Do NOT cancel when one completes — all must finish (or hit individual caps).
   */
  private async runBestOfN(
    request: CompletionRequest,
    config: EnsembleConfig,
    ensembleId: string,
    parentAbort: AbortController,
  ): Promise<EnsembleResult> {
    const scorer = resolveScorer(config)
    const childAborts: AbortController[] = []

    const promises = config.models.map((pool) => {
      const childAbort = new AbortController()
      childAborts.push(childAbort)
      parentAbort.signal.addEventListener("abort", () => childAbort.abort(), { once: true })
      return this.invokeModel(pool, request, config, childAbort)
    })

    const allResults = await Promise.allSettled(promises)
    const modelResults: EnsembleModelResult[] = allResults.map((settled, i) => {
      if (settled.status === "fulfilled") return settled.value
      return {
        pool: config.models[i],
        result: null,
        error: String(settled.reason),
        cost_micro: 0,
        latency_ms: 0,
      }
    })

    // Enforce total budget
    const totalCost = modelResults.reduce((sum, r) => sum + r.cost_micro, 0)
    if (totalCost > config.budget_total_micro) {
      throw new Error(`Ensemble budget exceeded: ${totalCost} > ${config.budget_total_micro} micro-USD`)
    }

    // Score successful results (async scorer)
    const successfulResults = modelResults.filter(r => r.result !== null)
    if (successfulResults.length === 0) {
      throw new Error(`Ensemble best_of_n: all ${config.models.length} models failed`)
    }

    let bestResult = successfulResults[0]
    let bestScore = await scorer(bestResult.result!)

    for (let i = 1; i < successfulResults.length; i++) {
      const score = await scorer(successfulResults[i].result!)
      if (score > bestScore) {
        bestScore = score
        bestResult = successfulResults[i]
      }
    }

    return {
      ensemble_id: ensembleId,
      selected: bestResult.result!,
      all_results: modelResults,
      strategy_used: "best_of_n",
      total_cost_micro: totalCost,
    }
  }

  // --- consensus ---

  /**
   * Run all models, parse structured JSON output, majority vote per field.
   */
  private async runConsensus(
    request: CompletionRequest,
    config: EnsembleConfig,
    ensembleId: string,
    parentAbort: AbortController,
  ): Promise<EnsembleResult> {
    const extractor = config.fieldExtractor ?? defaultFieldExtractor
    const childAborts: AbortController[] = []

    const promises = config.models.map((pool) => {
      const childAbort = new AbortController()
      childAborts.push(childAbort)
      parentAbort.signal.addEventListener("abort", () => childAbort.abort(), { once: true })
      return this.invokeModel(pool, request, config, childAbort)
    })

    const allResults = await Promise.allSettled(promises)
    const modelResults: EnsembleModelResult[] = allResults.map((settled, i) => {
      if (settled.status === "fulfilled") return settled.value
      return {
        pool: config.models[i],
        result: null,
        error: String(settled.reason),
        cost_micro: 0,
        latency_ms: 0,
      }
    })

    // Enforce total budget
    const totalCost = modelResults.reduce((sum, r) => sum + r.cost_micro, 0)
    if (totalCost > config.budget_total_micro) {
      throw new Error(`Ensemble budget exceeded: ${totalCost} > ${config.budget_total_micro} micro-USD`)
    }

    // Extract structured fields from each result
    const successfulResults = modelResults.filter(r => r.result !== null)
    if (successfulResults.length === 0) {
      throw new Error(`Ensemble consensus: all ${config.models.length} models failed`)
    }

    const parsedFields = successfulResults
      .map(r => extractor(r.result!))
      .filter((f): f is Record<string, unknown> => f !== null)

    if (parsedFields.length === 0) {
      // Fall back to first successful result if none parse as JSON
      return {
        ensemble_id: ensembleId,
        selected: successfulResults[0].result!,
        all_results: modelResults,
        strategy_used: "consensus",
        total_cost_micro: totalCost,
      }
    }

    // Majority vote per field
    const consensusFields = majorityVote(parsedFields)
    const consensusJson = JSON.stringify(consensusFields)

    // Build a synthetic CompletionResult with consensus content
    const baseResult = successfulResults[0].result!
    const consensusResult: CompletionResult = {
      content: consensusJson,
      thinking: null,
      tool_calls: null,
      usage: aggregateUsage(successfulResults.map(r => r.result!.usage)),
      metadata: {
        ...baseResult.metadata,
        model: `ensemble:consensus:${config.models.join("+")}`,
      },
    }

    return {
      ensemble_id: ensembleId,
      selected: consensusResult,
      all_results: modelResults,
      strategy_used: "consensus",
      total_cost_micro: totalCost,
    }
  }

  // --- Shared invocation ---

  /**
   * Invoke a single model with per-model budget enforcement.
   */
  private async invokeModel(
    pool: string,
    request: CompletionRequest,
    config: EnsembleConfig,
    childAbort: AbortController,
  ): Promise<EnsembleModelResult> {
    const start = Date.now()

    try {
      const { adapter, pricing } = this.resolver.resolve(pool)

      // Pre-calculate max_tokens from per-model budget cap
      let maxTokensFromBudget: number | undefined
      if (config.budget_per_model_micro > 0 && pricing.output_per_1m > 0) {
        maxTokensFromBudget = Math.floor(config.budget_per_model_micro / pricing.output_per_1m)
      }
      const effectiveMaxTokens =
        request.options.max_tokens !== undefined && maxTokensFromBudget !== undefined
          ? Math.min(request.options.max_tokens, maxTokensFromBudget)
          : request.options.max_tokens ?? maxTokensFromBudget

      const adjustedRequest: CompletionRequest = {
        ...request,
        options: {
          ...request.options,
          ...(effectiveMaxTokens !== undefined ? { max_tokens: effectiveMaxTokens } : {}),
        },
      }

      const result = await adapter.complete(adjustedRequest)
      const costMicro = Math.round(calculateCost(result.usage, pricing) * 1_000_000)
      const latencyMs = Date.now() - start

      // Check per-model budget after completion
      if (costMicro > config.budget_per_model_micro) {
        return {
          pool,
          result: null,
          error: `Per-model budget exceeded: ${costMicro} > ${config.budget_per_model_micro} micro-USD`,
          cost_micro: costMicro,
          latency_ms: latencyMs,
        }
      }

      return {
        pool,
        result,
        error: null,
        cost_micro: costMicro,
        latency_ms: latencyMs,
      }
    } catch (err) {
      return {
        pool,
        result: null,
        error: err instanceof Error ? err.message : String(err),
        cost_micro: 0,
        latency_ms: Date.now() - start,
      }
    }
  }
}

// --- Consensus Helpers ---

/** Default field extractor: try JSON.parse on content */
function defaultFieldExtractor(result: CompletionResult): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result.content)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Not JSON
  }
  return null
}

/** Majority vote per field across multiple parsed objects */
function majorityVote(fields: Record<string, unknown>[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const allKeys = new Set(fields.flatMap(f => Object.keys(f)))

  for (const key of allKeys) {
    const votes = new Map<string, number>()

    for (const field of fields) {
      if (key in field) {
        const serialized = JSON.stringify(field[key])
        votes.set(serialized, (votes.get(serialized) ?? 0) + 1)
      }
    }

    // Pick value with most votes
    let maxVotes = 0
    let winner = ""
    for (const [serialized, count] of votes) {
      if (count > maxVotes) {
        maxVotes = count
        winner = serialized
      }
    }

    if (winner) {
      result[key] = JSON.parse(winner)
    }
  }

  return result
}

/** Aggregate usage across multiple results */
function aggregateUsage(usages: UsageInfo[]): UsageInfo {
  return {
    prompt_tokens: usages.reduce((sum, u) => sum + (u.prompt_tokens ?? 0), 0),
    completion_tokens: usages.reduce((sum, u) => sum + (u.completion_tokens ?? 0), 0),
    reasoning_tokens: usages.reduce((sum, u) => sum + (u.reasoning_tokens ?? 0), 0),
  }
}

// --- Cost Attribution (T-B.4) ---

/**
 * Build per-model UsageReport entries from an EnsembleResult.
 * Each model gets its own report with shared ensemble_id and trace_id.
 * Reports are sent individually (not aggregated) to arrakis.
 */
export function buildEnsembleUsageReports(
  ensembleResult: EnsembleResult,
  context: ExecutionContext,
): UsageReport[] {
  const reports: UsageReport[] = []

  for (const modelResult of ensembleResult.all_results) {
    if (!modelResult.result) continue // Skip failed models (no usage to report)

    reports.push({
      report_id: ulid(),
      tenant_id: context.scopeMeta.project_id,
      pool_id: modelResult.pool,
      model: modelResult.result.metadata.model,
      input_tokens: modelResult.result.usage.prompt_tokens,
      output_tokens: modelResult.result.usage.completion_tokens,
      cost_micro: modelResult.cost_micro,
      timestamp: new Date().toISOString(),
      ensemble_id: ensembleResult.ensemble_id,
    })
  }

  return reports
}

/**
 * Build per-model LedgerEntry records from an EnsembleResult.
 * Each model gets its own JSONL entry with shared trace_id and ensemble_id.
 */
export function buildEnsembleLedgerEntries(
  ensembleResult: EnsembleResult,
  context: ExecutionContext,
): LedgerEntry[] {
  const entries: LedgerEntry[] = []

  for (const modelResult of ensembleResult.all_results) {
    if (!modelResult.result) continue

    const usage = modelResult.result.usage
    const costUsd = modelResult.cost_micro / 1_000_000
    const inputCostUsd = (usage.prompt_tokens * context.pricing.input_per_1m) / 1_000_000
    const outputCostUsd = (usage.completion_tokens * context.pricing.output_per_1m) / 1_000_000

    entries.push({
      timestamp: new Date().toISOString(),
      trace_id: context.binding.agent, // shared across ensemble (context-level identifier)
      agent: context.binding.agent,
      provider: modelResult.pool,
      model: modelResult.result.metadata.model,
      project_id: context.scopeMeta.project_id,
      phase_id: context.scopeMeta.phase_id,
      sprint_id: context.scopeMeta.sprint_id,
      tenant_id: "local",
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      reasoning_tokens: usage.reasoning_tokens,
      input_cost_usd: inputCostUsd,
      output_cost_usd: outputCostUsd,
      total_cost_usd: costUsd,
      latency_ms: modelResult.latency_ms,
      ensemble_id: ensembleResult.ensemble_id,
    })
  }

  return entries
}
