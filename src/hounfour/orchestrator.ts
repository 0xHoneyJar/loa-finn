// src/hounfour/orchestrator.ts — Tool-call orchestration loop (SDD §4.5, T-1.5)

import { randomUUID } from "node:crypto"
import type { IdempotencyPort, ToolResult } from "./idempotency.js"
import type {
  CompletionRequest,
  CompletionResult,
  ToolCall,
  ToolDefinition,
  CanonicalMessage,
  CompletionOptions,
  RequestMetadata,
  ToolCallConfig,
  ModelPortBase,
  ModelPortStreaming,
  ModelPort,
  StreamChunk,
  StreamUsageData,
} from "./types.js"
import { DEFAULT_TOOL_CALL_CONFIG, isStreamingPort } from "./types.js"
import { HounfourError } from "./errors.js"
import { ToolCallAssembler } from "./tool-call-assembler.js"

// --- Event Types ---

export type OrchestratorEventType =
  | "iteration_start"
  | "stream_start"
  | "token"
  | "tool_requested"
  | "tool_executing"
  | "tool_executed"
  | "tool_result_fed"
  | "budget_check"
  | "iteration_complete"
  | "loop_complete"
  | "loop_error"

export interface OrchestratorEvent {
  type: OrchestratorEventType
  trace_id: string
  iteration: number
  timestamp: string
  data: Record<string, unknown>
}

// --- Result ---

export interface OrchestratorResult {
  result: CompletionResult
  iterations: number
  totalToolCalls: number
  wallTimeMs: number
  abortReason?: "budget_exceeded" | "wall_time" | "max_iterations" | "max_tool_calls" | "consecutive_failures" | "cancelled"
}

// --- Options ---

export interface OrchestratorOptions {
  temperature?: number
  max_tokens?: number
  stream?: boolean
  onEvent?: (event: OrchestratorEvent) => void
  signal?: AbortSignal
}

// --- Ports ---

/** Executes a single tool call in a sandboxed environment */
export interface ToolExecutor {
  execute(
    toolName: string,
    args: Record<string, unknown>,
    traceId: string,
  ): Promise<ToolResult>
}

/** Budget check port — returns remaining budget info */
export interface BudgetChecker {
  checkBudget(traceId: string): Promise<{ exceeded: boolean; remainingUsd: number }>
}

// --- Token Approximation ---

/** Approximate token count from text (4 chars ≈ 1 token) */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// --- Orchestrator ---

export interface OrchestratorDeps {
  model: ModelPort
  toolExecutor: ToolExecutor
  idempotencyCache: IdempotencyPort
  budgetChecker?: BudgetChecker
}

export class Orchestrator {
  private config: ToolCallConfig
  private activeExecutions: Map<string, AbortController> = new Map()

  constructor(
    private deps: OrchestratorDeps,
    config?: Partial<ToolCallConfig>,
  ) {
    this.config = { ...DEFAULT_TOOL_CALL_CONFIG, ...config }
  }

  /**
   * Cancel an active execution by trace ID.
   * Triggers the AbortController for the corresponding invocation,
   * which aborts the sidecar HTTP request mid-stream.
   */
  cancel(traceId: string): void {
    const controller = this.activeExecutions.get(traceId)
    if (controller) {
      controller.abort()
      this.activeExecutions.delete(traceId)
    }
  }

  /**
   * Execute a tool-call loop.
   *
   * Flow per iteration:
   * 1. Budget check — abort if exceeded
   * 2. Wall time check — abort if >maxWallTimeMs
   * 3. Invoke model
   * 4. If no tool_calls → return final result
   * 5. For each tool_call:
   *    a. Check idempotency cache
   *    b. If cached → use cached result
   *    c. Execute via ToolExecutor
   *    d. Cache result
   *    e. Track consecutive failures
   * 6. Append tool results as messages
   * 7. Check limits → loop back
   */
  async execute(
    messages: CanonicalMessage[],
    tools: ToolDefinition[],
    metadata: RequestMetadata,
    options?: OrchestratorOptions,
  ): Promise<OrchestratorResult> {
    const traceId = metadata.trace_id
    const onEvent = options?.onEvent
    const startTime = Date.now()
    const conversationMessages = [...messages]
    let totalToolCalls = 0
    let consecutiveFailures = 0

    for (let iteration = 0; iteration < this.config.maxIterations; iteration++) {
      // --- Pre-flight checks ---

      // Wall time
      const elapsed = Date.now() - startTime
      if (elapsed > this.config.maxWallTimeMs) {
        throw new HounfourError("TOOL_CALL_WALL_TIME_EXCEEDED", `Wall time ${elapsed}ms exceeds ${this.config.maxWallTimeMs}ms`, {
          trace_id: traceId,
          iterations: iteration,
          wallTimeMs: elapsed,
        })
      }

      // Budget check
      if (this.deps.budgetChecker) {
        const budget = await this.deps.budgetChecker.checkBudget(traceId)
        this.emit(onEvent, {
          type: "budget_check",
          trace_id: traceId,
          iteration,
          timestamp: new Date().toISOString(),
          data: { exceeded: budget.exceeded, remainingUsd: budget.remainingUsd },
        })
        if (budget.exceeded) {
          throw new HounfourError("BUDGET_EXCEEDED", "Budget exceeded before iteration", {
            trace_id: traceId,
            iterations: iteration,
          })
        }
      }

      this.emit(onEvent, {
        type: "iteration_start",
        trace_id: traceId,
        iteration,
        timestamp: new Date().toISOString(),
        data: { totalToolCalls, consecutiveFailures },
      })

      // --- Invoke model ---

      const request: CompletionRequest = {
        messages: conversationMessages,
        tools: tools.length > 0 ? tools : undefined,
        options: {
          temperature: options?.temperature,
          max_tokens: options?.max_tokens,
        },
        metadata,
      }

      const result = await this.deps.model.complete(request)

      this.emit(onEvent, {
        type: "iteration_complete",
        trace_id: traceId,
        iteration,
        timestamp: new Date().toISOString(),
        data: {
          hasToolCalls: result.tool_calls !== null,
          toolCallCount: result.tool_calls?.length ?? 0,
          usage: result.usage,
        },
      })

      // --- No tool calls → done ---

      if (!result.tool_calls || result.tool_calls.length === 0) {
        const wallTimeMs = Date.now() - startTime
        this.emit(onEvent, {
          type: "loop_complete",
          trace_id: traceId,
          iteration: iteration + 1,
          timestamp: new Date().toISOString(),
          data: { totalToolCalls, wallTimeMs },
        })
        return {
          result,
          iterations: iteration + 1,
          totalToolCalls,
          wallTimeMs,
        }
      }

      // --- Process tool calls ---

      // Add assistant message with tool calls
      conversationMessages.push({
        role: "assistant",
        content: result.content || null,
        tool_calls: result.tool_calls,
      })

      for (const toolCall of result.tool_calls) {
        // Check total tool calls limit
        totalToolCalls++
        if (totalToolCalls > this.config.maxTotalToolCalls) {
          throw new HounfourError("TOOL_CALL_LIMIT_EXCEEDED", `Total tool calls ${totalToolCalls} exceeds limit ${this.config.maxTotalToolCalls}`, {
            trace_id: traceId,
            iterations: iteration + 1,
            totalToolCalls,
          })
        }

        const toolName = toolCall.function.name
        let args: Record<string, unknown>

        // Parse arguments
        try {
          args = JSON.parse(toolCall.function.arguments)
        } catch {
          // Malformed JSON — feed error back to model
          const errorResult: ToolResult = {
            output: `Invalid JSON in tool arguments: ${toolCall.function.arguments.slice(0, 200)}`,
            is_error: true,
          }
          conversationMessages.push({
            role: "tool",
            content: errorResult.output,
            tool_call_id: toolCall.id,
            name: toolName,
          })
          consecutiveFailures++
          if (consecutiveFailures >= this.config.abortOnConsecutiveFailures) {
            throw new HounfourError("TOOL_CALL_CONSECUTIVE_FAILURES", `${consecutiveFailures} consecutive failures`, {
              trace_id: traceId,
              iterations: iteration + 1,
              totalToolCalls,
            })
          }
          continue
        }

        this.emit(onEvent, {
          type: "tool_requested",
          trace_id: traceId,
          iteration,
          timestamp: new Date().toISOString(),
          data: { toolName, toolCallId: toolCall.id },
        })

        // Check idempotency cache
        const cached = await this.deps.idempotencyCache.get(traceId, toolName, args)
        let toolResult: ToolResult

        if (cached) {
          toolResult = cached
        } else {
          // Execute tool
          try {
            toolResult = await this.deps.toolExecutor.execute(toolName, args, traceId)
          } catch (err) {
            toolResult = {
              output: `Tool execution error: ${(err as Error).message}`,
              is_error: true,
            }
          }

          // Cache result
          await this.deps.idempotencyCache.set(traceId, toolName, args, toolResult)
        }

        this.emit(onEvent, {
          type: "tool_executed",
          trace_id: traceId,
          iteration,
          timestamp: new Date().toISOString(),
          data: {
            toolName,
            toolCallId: toolCall.id,
            isError: toolResult.is_error,
            cached: cached !== null,
          },
        })

        // Track consecutive failures
        if (toolResult.is_error) {
          consecutiveFailures++
          if (consecutiveFailures >= this.config.abortOnConsecutiveFailures) {
            throw new HounfourError("TOOL_CALL_CONSECUTIVE_FAILURES", `${consecutiveFailures} consecutive failures`, {
              trace_id: traceId,
              iterations: iteration + 1,
              totalToolCalls,
            })
          }
        } else {
          consecutiveFailures = 0
        }

        // Append tool result message
        conversationMessages.push({
          role: "tool",
          content: toolResult.output,
          tool_call_id: toolCall.id,
          name: toolName,
        })
      }
    }

    // Exhausted max iterations
    throw new HounfourError("TOOL_CALL_MAX_ITERATIONS", `Reached max iterations: ${this.config.maxIterations}`, {
      trace_id: traceId,
      iterations: this.config.maxIterations,
      totalToolCalls,
    })
  }

  /**
   * Streaming variant — yields OrchestratorEvents as they occur.
   *
   * Same loop logic as execute() but:
   * - Uses model.stream() when available (falls back to blocking)
   * - Yields token events as they arrive from SSE
   * - Assembles tool_calls incrementally via ToolCallAssembler
   * - Tracks running token count from deltas (tiered accounting)
   * - Supports mid-stream budget enforcement via abort
   * - Supports external cancellation via cancel(traceId)
   *
   * Returns OrchestratorResult when the generator completes.
   */
  async *executeStreaming(
    messages: CanonicalMessage[],
    tools: ToolDefinition[],
    metadata: RequestMetadata,
    options?: OrchestratorOptions,
  ): AsyncGenerator<OrchestratorEvent, OrchestratorResult> {
    const traceId = metadata.trace_id
    const startTime = Date.now()
    const conversationMessages = [...messages]
    let totalToolCalls = 0
    let consecutiveFailures = 0

    // Register abort controller for this execution
    const abortController = new AbortController()
    this.activeExecutions.set(traceId, abortController)

    // Link external signal if provided
    if (options?.signal) {
      if (options.signal.aborted) {
        abortController.abort()
      } else {
        options.signal.addEventListener(
          "abort",
          () => abortController.abort(),
          { once: true },
        )
      }
    }

    try {
      for (let iteration = 0; iteration < this.config.maxIterations; iteration++) {
        // --- Pre-flight checks ---

        if (abortController.signal.aborted) {
          return {
            result: {
              content: "",
              thinking: null,
              tool_calls: null,
              usage: { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 },
              metadata: { model: "", latency_ms: 0, trace_id: traceId },
            },
            iterations: iteration,
            totalToolCalls,
            wallTimeMs: Date.now() - startTime,
            abortReason: "cancelled",
          }
        }

        // Wall time
        const elapsed = Date.now() - startTime
        if (elapsed > this.config.maxWallTimeMs) {
          throw new HounfourError("TOOL_CALL_WALL_TIME_EXCEEDED", `Wall time ${elapsed}ms exceeds ${this.config.maxWallTimeMs}ms`, {
            trace_id: traceId,
            iterations: iteration,
            wallTimeMs: elapsed,
          })
        }

        // Budget check
        if (this.deps.budgetChecker) {
          const budget = await this.deps.budgetChecker.checkBudget(traceId)
          const budgetEvent: OrchestratorEvent = {
            type: "budget_check",
            trace_id: traceId,
            iteration,
            timestamp: new Date().toISOString(),
            data: { exceeded: budget.exceeded, remainingUsd: budget.remainingUsd },
          }
          yield budgetEvent
          if (budget.exceeded) {
            throw new HounfourError("BUDGET_EXCEEDED", "Budget exceeded before iteration", {
              trace_id: traceId,
              iterations: iteration,
            })
          }
        }

        yield {
          type: "iteration_start",
          trace_id: traceId,
          iteration,
          timestamp: new Date().toISOString(),
          data: { totalToolCalls, consecutiveFailures },
        }

        // --- Build request ---

        const request: CompletionRequest = {
          messages: conversationMessages,
          tools: tools.length > 0 ? tools : undefined,
          options: {
            temperature: options?.temperature,
            max_tokens: options?.max_tokens,
          },
          metadata,
        }

        // --- Stream or blocking invoke ---

        const model = this.deps.model
        const useStreaming = options?.stream !== false && isStreamingPort(model)
        let result: CompletionResult
        let streamedContent = ""
        let streamUsage: StreamUsageData | null = null

        if (useStreaming) {
          yield {
            type: "stream_start",
            trace_id: traceId,
            iteration,
            timestamp: new Date().toISOString(),
            data: {},
          }

          const assembler = new ToolCallAssembler()
          let runningTokenCount = 0

          for await (const chunk of (model as ModelPortStreaming).stream(request, { signal: abortController.signal })) {
            if (abortController.signal.aborted) break

            switch (chunk.event) {
              case "chunk": {
                const delta = chunk.data.delta
                if (delta) {
                  streamedContent += delta
                  runningTokenCount += approxTokens(delta)

                  yield {
                    type: "token",
                    trace_id: traceId,
                    iteration,
                    timestamp: new Date().toISOString(),
                    data: { delta, runningTokenCount },
                  }
                }
                break
              }

              case "tool_call": {
                const earlyCompleted = assembler.feed(chunk.data)
                for (const tc of earlyCompleted) {
                  yield {
                    type: "tool_requested",
                    trace_id: traceId,
                    iteration,
                    timestamp: new Date().toISOString(),
                    data: { toolName: tc.function.name, toolCallId: tc.id, early: true },
                  }
                }
                break
              }

              case "usage": {
                streamUsage = chunk.data
                // Reconcile running count with ground truth
                runningTokenCount = chunk.data.completion_tokens
                break
              }

              case "done": {
                // Finalize remaining tool calls
                const finalized = assembler.finalize()
                for (const tc of finalized) {
                  yield {
                    type: "tool_requested",
                    trace_id: traceId,
                    iteration,
                    timestamp: new Date().toISOString(),
                    data: { toolName: tc.function.name, toolCallId: tc.id, early: false },
                  }
                }
                break
              }

              case "error": {
                yield {
                  type: "loop_error",
                  trace_id: traceId,
                  iteration,
                  timestamp: new Date().toISOString(),
                  data: { code: chunk.data.code, message: chunk.data.message },
                }
                throw new HounfourError("STREAM_ERROR", `Stream error: ${chunk.data.code} - ${chunk.data.message}`, {
                  trace_id: traceId,
                  iterations: iteration,
                })
              }
            }
          }

          // Build CompletionResult from streamed data
          const completedToolCalls = assembler.getCompleted()
          result = {
            content: streamedContent || "",
            thinking: null,
            tool_calls: completedToolCalls.length > 0 ? completedToolCalls : null,
            usage: streamUsage ?? { prompt_tokens: 0, completion_tokens: runningTokenCount, reasoning_tokens: 0 },
            metadata: { model: "", latency_ms: Date.now() - startTime, trace_id: traceId },
          }
        } else {
          // Blocking fallback
          result = await model.complete(request)
        }

        yield {
          type: "iteration_complete",
          trace_id: traceId,
          iteration,
          timestamp: new Date().toISOString(),
          data: {
            hasToolCalls: result.tool_calls !== null,
            toolCallCount: result.tool_calls?.length ?? 0,
            usage: result.usage,
            streamed: useStreaming,
          },
        }

        // --- No tool calls → done ---

        if (!result.tool_calls || result.tool_calls.length === 0) {
          const wallTimeMs = Date.now() - startTime
          yield {
            type: "loop_complete",
            trace_id: traceId,
            iteration: iteration + 1,
            timestamp: new Date().toISOString(),
            data: { totalToolCalls, wallTimeMs },
          }
          return {
            result,
            iterations: iteration + 1,
            totalToolCalls,
            wallTimeMs,
          }
        }

        // --- Process tool calls (same as blocking path) ---

        conversationMessages.push({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.tool_calls,
        })

        for (const toolCall of result.tool_calls) {
          totalToolCalls++
          if (totalToolCalls > this.config.maxTotalToolCalls) {
            throw new HounfourError("TOOL_CALL_LIMIT_EXCEEDED", `Total tool calls ${totalToolCalls} exceeds limit ${this.config.maxTotalToolCalls}`, {
              trace_id: traceId,
              iterations: iteration + 1,
              totalToolCalls,
            })
          }

          const toolName = toolCall.function.name
          let args: Record<string, unknown>

          try {
            args = JSON.parse(toolCall.function.arguments)
          } catch {
            const errorResult: ToolResult = {
              output: `Invalid JSON in tool arguments: ${toolCall.function.arguments.slice(0, 200)}`,
              is_error: true,
            }
            conversationMessages.push({
              role: "tool",
              content: errorResult.output,
              tool_call_id: toolCall.id,
              name: toolName,
            })
            consecutiveFailures++
            if (consecutiveFailures >= this.config.abortOnConsecutiveFailures) {
              throw new HounfourError("TOOL_CALL_CONSECUTIVE_FAILURES", `${consecutiveFailures} consecutive failures`, {
                trace_id: traceId,
                iterations: iteration + 1,
                totalToolCalls,
              })
            }
            continue
          }

          yield {
            type: "tool_executing",
            trace_id: traceId,
            iteration,
            timestamp: new Date().toISOString(),
            data: { toolName, toolCallId: toolCall.id },
          }

          // Check idempotency cache
          const cached = await this.deps.idempotencyCache.get(traceId, toolName, args)
          let toolResult: ToolResult

          if (cached) {
            toolResult = cached
          } else {
            try {
              toolResult = await this.deps.toolExecutor.execute(toolName, args, traceId)
            } catch (err) {
              toolResult = {
                output: `Tool execution error: ${(err as Error).message}`,
                is_error: true,
              }
            }
            await this.deps.idempotencyCache.set(traceId, toolName, args, toolResult)
          }

          yield {
            type: "tool_executed",
            trace_id: traceId,
            iteration,
            timestamp: new Date().toISOString(),
            data: {
              toolName,
              toolCallId: toolCall.id,
              isError: toolResult.is_error,
              cached: cached !== null,
            },
          }

          if (toolResult.is_error) {
            consecutiveFailures++
            if (consecutiveFailures >= this.config.abortOnConsecutiveFailures) {
              throw new HounfourError("TOOL_CALL_CONSECUTIVE_FAILURES", `${consecutiveFailures} consecutive failures`, {
                trace_id: traceId,
                iterations: iteration + 1,
                totalToolCalls,
              })
            }
          } else {
            consecutiveFailures = 0
          }

          conversationMessages.push({
            role: "tool",
            content: toolResult.output,
            tool_call_id: toolCall.id,
            name: toolName,
          })

          yield {
            type: "tool_result_fed",
            trace_id: traceId,
            iteration,
            timestamp: new Date().toISOString(),
            data: { toolName, toolCallId: toolCall.id },
          }
        }
      }

      // Exhausted max iterations
      throw new HounfourError("TOOL_CALL_MAX_ITERATIONS", `Reached max iterations: ${this.config.maxIterations}`, {
        trace_id: traceId,
        iterations: this.config.maxIterations,
        totalToolCalls,
      })
    } finally {
      this.activeExecutions.delete(traceId)
    }
  }

  private emit(
    onEvent: ((event: OrchestratorEvent) => void) | undefined,
    event: OrchestratorEvent,
  ): void {
    if (onEvent) {
      try {
        onEvent(event)
      } catch {
        // Don't let event handler errors break the loop
      }
    }
  }
}
