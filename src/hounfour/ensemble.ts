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
  ModelPortStreaming,
  PricingEntry,
  StreamChunk,
  UsageInfo,
} from "./types.js"
import { isStreamingPort } from "./types.js"
import type { UsageReport } from "./usage-reporter.js"
import { calculateCost } from "./budget.js"
import { StreamCostTracker, type StreamCostResult, type BillingMethod } from "./stream-cost.js"
import type { MicroPricingEntry } from "./pricing.js"

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

/** Resolves a pool ID to a streaming adapter and micro-USD pricing */
export interface StreamingModelResolver {
  resolve(pool: string): { adapter: ModelPortStreaming; pricing: MicroPricingEntry }
}

/** Per-branch status after ensemble completes */
export type EnsembleBranchStatus = "completed" | "cancelled" | "failed" | "timeout"

/** Per-branch result from streaming ensemble */
export interface EnsembleStreamingBranchResult {
  pool: string
  status: EnsembleBranchStatus
  cost: StreamCostResult | null
  latency_ms: number
  error: string | null
}

/** Result metadata from a streaming ensemble (available after stream ends) */
export interface EnsembleStreamingResult {
  ensemble_id: string
  winner_pool: string
  branches: EnsembleStreamingBranchResult[]
  total_cost_micro: bigint
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

// --- Streaming Ensemble ---

/**
 * Streaming first_complete ensemble: race N streaming adapters,
 * forward only the winner's chunks. Winner latch is safe in
 * single-threaded JS (no atomic/mutex needed).
 *
 * Returns: { stream, getResult } — consume stream, then call getResult()
 * for branch metadata and cost attribution.
 */
export function firstCompleteStreaming(
  pools: string[],
  request: CompletionRequest,
  resolver: StreamingModelResolver,
  options?: {
    timeoutMs?: number
    promptTokens?: number
    signal?: AbortSignal
  },
): {
  stream: AsyncGenerator<StreamChunk>
  getResult: () => EnsembleStreamingResult
} {
  if (pools.length === 0) {
    throw new Error("firstCompleteStreaming: no pools specified")
  }

  const ensembleId = ulid()
  const timeoutMs = options?.timeoutMs ?? 30_000
  const promptTokens = options?.promptTokens ?? 0

  // Per-branch state
  const controllers: AbortController[] = pools.map(() => new AbortController())
  const costTrackers: StreamCostTracker[] = []
  const branchResults: EnsembleStreamingBranchResult[] = pools.map((pool) => ({
    pool,
    status: "cancelled" as EnsembleBranchStatus,
    cost: null,
    latency_ms: 0,
    error: null,
  }))
  const branchStarts: number[] = pools.map(() => Date.now())

  // Winner latch — first branch to emit a chunk/tool_call wins
  let winnerIndex = -1
  let resultFinalized = false
  let finalResult: EnsembleStreamingResult | null = null

  // Resolve adapters and create cost trackers
  const adapters: ModelPortStreaming[] = []
  for (let i = 0; i < pools.length; i++) {
    const { adapter, pricing } = resolver.resolve(pools[i])
    adapters.push(adapter)
    costTrackers.push(
      new StreamCostTracker({ pricing, promptTokens }),
    )
  }

  // Link external abort signal to all controllers
  if (options?.signal) {
    options.signal.addEventListener("abort", () => {
      controllers.forEach((ctrl) => ctrl.abort())
    }, { once: true })
  }

  // Timeout: abort all branches
  const timeoutId = setTimeout(() => {
    controllers.forEach((ctrl) => ctrl.abort())
  }, timeoutMs)

  /**
   * Race all branches for the first content-bearing chunk.
   * Uses manual .next() calls instead of for-await to avoid
   * closing the winner's iterator prematurely.
   */
  async function raceForFirstChunk(): Promise<{
    winnerIdx: number
    firstChunk: StreamChunk
    iterators: AsyncGenerator<StreamChunk>[]
  }> {
    // Start all streams
    const iterators = adapters.map((adapter, i) =>
      costTrackers[i].track(
        adapter.stream(request, { signal: controllers[i].signal }),
        controllers[i].signal,
      ),
    )

    return new Promise<{
      winnerIdx: number
      firstChunk: StreamChunk
      iterators: AsyncGenerator<StreamChunk>[]
    }>((resolve, reject) => {
      let settled = false
      let doneCount = 0

      iterators.forEach((iter, i) => {
        // Pull chunks via .next() to avoid for-await closing the iterator
        ;(async () => {
          try {
            while (true) {
              if (settled) return // Another branch already won

              const { value, done } = await iter.next()
              if (done) {
                branchResults[i].status = "failed"
                branchResults[i].error = "Stream ended without content"
                break
              }

              // Winner latch: first branch to emit chunk or tool_call
              if (value.event === "chunk" || value.event === "tool_call") {
                if (!settled) {
                  settled = true
                  winnerIndex = i
                  branchResults[i].status = "completed"

                  // Cancel all other branches immediately
                  controllers.forEach((ctrl, j) => {
                    if (j !== i) ctrl.abort()
                  })

                  resolve({ winnerIdx: i, firstChunk: value, iterators })
                }
                return // Stop pulling from this branch — main generator takes over
              }
              // Skip non-content events during race (e.g., metadata)
            }
          } catch (err) {
            if (controllers[i].signal.aborted) {
              branchResults[i].status = "cancelled"
            } else {
              branchResults[i].status = "failed"
              branchResults[i].error = err instanceof Error ? err.message : String(err)
            }
          } finally {
            branchResults[i].latency_ms = Date.now() - branchStarts[i]
            doneCount++

            if (!settled && doneCount === pools.length) {
              reject(new Error(`firstCompleteStreaming: all ${pools.length} branches failed`))
            }
          }
        })()
      })
    })
  }

  // The main generator that yields winning stream chunks
  async function* generateStream(): AsyncGenerator<StreamChunk> {
    let iterators: AsyncGenerator<StreamChunk>[]

    try {
      const race = await raceForFirstChunk()
      iterators = race.iterators

      // Yield the winning first chunk
      yield race.firstChunk

      // Forward the rest of the winner's stream
      const winnerIter = iterators[race.winnerIdx]
      for await (const chunk of winnerIter) {
        yield chunk
      }
    } finally {
      clearTimeout(timeoutId)

      // Ensure all controllers are aborted (losers)
      controllers.forEach((ctrl) => ctrl.abort())

      // Finalize cost for all branches
      for (let i = 0; i < pools.length; i++) {
        branchResults[i].latency_ms = Date.now() - branchStarts[i]
        try {
          if (i === winnerIndex) {
            branchResults[i].cost = costTrackers[i].getResult()
          } else {
            branchResults[i].cost = costTrackers[i].getOvercountResult()
          }
        } catch {
          // Cost tracker may not have been started if branch failed early
          branchResults[i].cost = null
        }
      }

      // Compute total cost
      let totalCost = 0n
      for (const br of branchResults) {
        if (br.cost) totalCost += br.cost.total_cost_micro
      }

      finalResult = {
        ensemble_id: ensembleId,
        winner_pool: winnerIndex >= 0 ? pools[winnerIndex] : "",
        branches: branchResults,
        total_cost_micro: totalCost,
      }
      resultFinalized = true
    }
  }

  function getResult(): EnsembleStreamingResult {
    if (!resultFinalized || !finalResult) {
      throw new Error("firstCompleteStreaming: stream not yet consumed — call getResult() after stream ends")
    }
    return finalResult
  }

  return { stream: generateStream(), getResult }
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

// --- Streaming best_of_n & consensus (Task 3.7, B.4 part 3) ---

/** Options for bestOfNStreaming and consensusStreaming */
export interface EnsembleStreamingOptions {
  /** Overall timeout for the ensemble run (ms). Default: 30000 */
  timeoutMs?: number
  /** Per-branch timeout (ms). Branches exceeding this are aborted. Default: timeoutMs */
  perBranchTimeoutMs?: number
  /** Prompt tokens for cost estimation. Default: 0 */
  promptTokens?: number
  /** External abort signal */
  signal?: AbortSignal
}

/** Result from bestOfNStreaming or consensusStreaming */
export interface EnsembleStreamingFinalResult {
  ensemble_id: string
  selected: CompletionResult
  branches: EnsembleStreamingBranchResult[]
  total_cost_micro: bigint
  strategy: MergeStrategy
}

/**
 * Consume a single streaming branch fully, buffering content.
 * Returns the assembled CompletionResult and cost data.
 */
async function consumeBranch(
  adapter: ModelPortStreaming,
  request: CompletionRequest,
  costTracker: StreamCostTracker,
  controller: AbortController,
): Promise<{ content: string; usage: UsageInfo | null }> {
  let content = ""
  let usage: UsageInfo | null = null

  const tracked = costTracker.track(
    adapter.stream(request, { signal: controller.signal }),
    controller.signal,
  )

  for await (const chunk of tracked) {
    if (chunk.event === "chunk") {
      const data = chunk.data as { delta: string; tool_calls: unknown }
      content += data.delta ?? ""
    } else if (chunk.event === "usage") {
      usage = chunk.data as UsageInfo
    }
  }

  return { content, usage }
}

/**
 * Streaming best_of_n: launch all branches via streaming adapters,
 * consume all fully, score, return the best.
 *
 * Unlike firstCompleteStreaming, this waits for ALL branches (or timeout).
 * Returns a final result, not a stream — scoring requires all results.
 */
export async function bestOfNStreaming(
  pools: string[],
  request: CompletionRequest,
  resolver: StreamingModelResolver,
  options?: EnsembleStreamingOptions & {
    scorer?: ScorerFunction
    quorum?: number
  },
): Promise<EnsembleStreamingFinalResult> {
  if (pools.length === 0) {
    throw new Error("bestOfNStreaming: no pools specified")
  }

  const ensembleId = ulid()
  const timeoutMs = options?.timeoutMs ?? 30_000
  const perBranchTimeoutMs = options?.perBranchTimeoutMs ?? timeoutMs
  const promptTokens = options?.promptTokens ?? 0
  const quorum = options?.quorum ?? 1
  const scorer = options?.scorer ?? (async (r: CompletionResult) => defaultSyncScorer(r))

  const controllers: AbortController[] = pools.map(() => new AbortController())
  const costTrackers: StreamCostTracker[] = []
  const branchResults: EnsembleStreamingBranchResult[] = pools.map((pool) => ({
    pool,
    status: "failed" as EnsembleBranchStatus,
    cost: null,
    latency_ms: 0,
    error: null,
  }))

  // Resolve adapters and create cost trackers
  const adapters: ModelPortStreaming[] = []
  for (let i = 0; i < pools.length; i++) {
    const { adapter, pricing } = resolver.resolve(pools[i])
    adapters.push(adapter)
    costTrackers.push(new StreamCostTracker({ pricing, promptTokens }))
  }

  // Link external abort signal
  if (options?.signal) {
    options.signal.addEventListener("abort", () => {
      controllers.forEach((ctrl) => ctrl.abort())
    }, { once: true })
  }

  // Global timeout
  const globalTimer = setTimeout(() => {
    controllers.forEach((ctrl) => ctrl.abort())
  }, timeoutMs)

  // Per-branch timeouts
  const branchTimers = controllers.map((ctrl) =>
    setTimeout(() => ctrl.abort(), perBranchTimeoutMs),
  )

  // Launch all branches in parallel
  const branchPromises = pools.map(async (pool, i) => {
    const start = Date.now()
    try {
      const { content, usage } = await consumeBranch(
        adapters[i], request, costTrackers[i], controllers[i],
      )
      branchResults[i].latency_ms = Date.now() - start

      // Check if branch was aborted (timeout or external signal)
      if (controllers[i].signal.aborted) {
        branchResults[i].status = "timeout"
        try { branchResults[i].cost = costTrackers[i].getOvercountResult() } catch { /* no data */ }
        return null
      }

      branchResults[i].status = "completed"
      branchResults[i].cost = costTrackers[i].getResult()
      return {
        content,
        usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 },
        pool,
      }
    } catch (err) {
      branchResults[i].latency_ms = Date.now() - start
      if (controllers[i].signal.aborted) {
        branchResults[i].status = "timeout"
      } else {
        branchResults[i].status = "failed"
      }
      branchResults[i].error = err instanceof Error ? err.message : String(err)
      try { branchResults[i].cost = costTrackers[i].getOvercountResult() } catch { /* no data */ }
      return null
    }
  })

  try {
    const results = await Promise.all(branchPromises)
    clearTimeout(globalTimer)
    branchTimers.forEach(clearTimeout)

    // Filter successful results
    const successful = results.filter((r): r is NonNullable<typeof r> => r !== null)

    if (successful.length < quorum) {
      throw new Error(
        `bestOfNStreaming: only ${successful.length}/${pools.length} branches succeeded (quorum: ${quorum})`,
      )
    }

    // Score and select best
    let bestIdx = 0
    let bestScore = -Infinity
    for (let i = 0; i < successful.length; i++) {
      const completionResult: CompletionResult = {
        content: successful[i].content,
        thinking: null,
        tool_calls: null,
        usage: successful[i].usage,
        metadata: { model: successful[i].pool },
      }
      const score = await scorer(completionResult)
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
      }
    }

    const best = successful[bestIdx]
    const selected: CompletionResult = {
      content: best.content,
      thinking: null,
      tool_calls: null,
      usage: best.usage,
      metadata: { model: best.pool },
    }

    let totalCost = 0n
    for (const br of branchResults) {
      if (br.cost) totalCost += br.cost.total_cost_micro
    }

    return {
      ensemble_id: ensembleId,
      selected,
      branches: branchResults,
      total_cost_micro: totalCost,
      strategy: "best_of_n",
    }
  } finally {
    clearTimeout(globalTimer)
    branchTimers.forEach(clearTimeout)
    controllers.forEach((ctrl) => ctrl.abort())
  }
}

/**
 * Streaming consensus: launch all branches via streaming adapters,
 * consume all fully, merge via field extraction + majority vote.
 *
 * Returns a final result — consensus requires all branch outputs.
 */
export async function consensusStreaming(
  pools: string[],
  request: CompletionRequest,
  resolver: StreamingModelResolver,
  options?: EnsembleStreamingOptions & {
    quorum?: number
    fieldExtractor?: (result: CompletionResult) => Record<string, unknown> | null
  },
): Promise<EnsembleStreamingFinalResult> {
  if (pools.length === 0) {
    throw new Error("consensusStreaming: no pools specified")
  }

  const ensembleId = ulid()
  const timeoutMs = options?.timeoutMs ?? 30_000
  const perBranchTimeoutMs = options?.perBranchTimeoutMs ?? timeoutMs
  const promptTokens = options?.promptTokens ?? 0
  const quorum = options?.quorum ?? pools.length // Default: all must succeed
  const extractor = options?.fieldExtractor ?? defaultFieldExtractor

  const controllers: AbortController[] = pools.map(() => new AbortController())
  const costTrackers: StreamCostTracker[] = []
  const branchResults: EnsembleStreamingBranchResult[] = pools.map((pool) => ({
    pool,
    status: "failed" as EnsembleBranchStatus,
    cost: null,
    latency_ms: 0,
    error: null,
  }))

  const adapters: ModelPortStreaming[] = []
  for (let i = 0; i < pools.length; i++) {
    const { adapter, pricing } = resolver.resolve(pools[i])
    adapters.push(adapter)
    costTrackers.push(new StreamCostTracker({ pricing, promptTokens }))
  }

  if (options?.signal) {
    options.signal.addEventListener("abort", () => {
      controllers.forEach((ctrl) => ctrl.abort())
    }, { once: true })
  }

  const globalTimer = setTimeout(() => {
    controllers.forEach((ctrl) => ctrl.abort())
  }, timeoutMs)

  const branchTimers = controllers.map((ctrl) =>
    setTimeout(() => ctrl.abort(), perBranchTimeoutMs),
  )

  const branchPromises = pools.map(async (pool, i) => {
    const start = Date.now()
    try {
      const { content, usage } = await consumeBranch(
        adapters[i], request, costTrackers[i], controllers[i],
      )
      branchResults[i].latency_ms = Date.now() - start

      // Check if branch was aborted (timeout or external signal)
      if (controllers[i].signal.aborted) {
        branchResults[i].status = "timeout"
        try { branchResults[i].cost = costTrackers[i].getOvercountResult() } catch { /* no data */ }
        return null
      }

      branchResults[i].status = "completed"
      branchResults[i].cost = costTrackers[i].getResult()
      return {
        content,
        usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 },
        pool,
      }
    } catch (err) {
      branchResults[i].latency_ms = Date.now() - start
      if (controllers[i].signal.aborted) {
        branchResults[i].status = "timeout"
      } else {
        branchResults[i].status = "failed"
      }
      branchResults[i].error = err instanceof Error ? err.message : String(err)
      try { branchResults[i].cost = costTrackers[i].getOvercountResult() } catch { /* no data */ }
      return null
    }
  })

  try {
    const results = await Promise.all(branchPromises)
    clearTimeout(globalTimer)
    branchTimers.forEach(clearTimeout)

    const successful = results.filter((r): r is NonNullable<typeof r> => r !== null)

    if (successful.length < quorum) {
      throw new Error(
        `consensusStreaming: only ${successful.length}/${pools.length} branches succeeded (quorum: ${quorum})`,
      )
    }

    // Build CompletionResults for field extraction
    const completionResults: CompletionResult[] = successful.map((r) => ({
      content: r.content,
      thinking: null,
      tool_calls: null,
      usage: r.usage,
      metadata: { model: r.pool },
    }))

    // Extract structured fields and run majority vote
    const parsedFields = completionResults
      .map((cr) => extractor(cr))
      .filter((f): f is Record<string, unknown> => f !== null)

    let selected: CompletionResult
    if (parsedFields.length >= 2) {
      // Enough structured data for majority vote
      const consensusFields = majorityVote(parsedFields)
      selected = {
        content: JSON.stringify(consensusFields),
        thinking: null,
        tool_calls: null,
        usage: aggregateUsage(successful.map((r) => r.usage)),
        metadata: { model: `ensemble:consensus:${pools.join("+")}` },
      }
    } else {
      // Not enough structured data — fall back to first successful
      selected = completionResults[0]
    }

    let totalCost = 0n
    for (const br of branchResults) {
      if (br.cost) totalCost += br.cost.total_cost_micro
    }

    return {
      ensemble_id: ensembleId,
      selected,
      branches: branchResults,
      total_cost_micro: totalCost,
      strategy: "consensus",
    }
  } finally {
    clearTimeout(globalTimer)
    branchTimers.forEach(clearTimeout)
    controllers.forEach((ctrl) => ctrl.abort())
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
