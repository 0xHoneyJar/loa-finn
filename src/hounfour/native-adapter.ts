// src/hounfour/native-adapter.ts — Anthropic Messages API Adapter (SDD §3.6, T-B.2)
// Wraps Anthropic Messages API as ModelPortBase + ModelPortStreaming.
// Registered as provider type "claude-code" / provider name "anthropic-direct".

import type {
  ModelPortBase,
  ModelPortStreaming,
  CompletionRequest,
  CompletionResult,
  CompletionOptions,
  CanonicalMessage,
  ToolDefinition,
  ToolCall,
  UsageInfo,
  HealthStatus,
  ModelCapabilities,
  StreamChunk,
  ResolvedModel,
  ProviderEntry,
  RetryPolicy,
} from "./types.js"
import { DEFAULT_RETRY_POLICY } from "./types.js"

// --- Anthropic API Types ---

interface AnthropicMessage {
  role: "user" | "assistant"
  content: AnthropicContentBlock[]
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "thinking"; thinking: string }

interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

interface AnthropicRequest {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  system?: string
  tools?: AnthropicTool[]
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string }
  stream?: boolean
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
}

interface AnthropicResponse {
  id: string
  type: "message"
  role: "assistant"
  content: AnthropicContentBlock[]
  model: string
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null
  usage: { input_tokens: number; output_tokens: number }
}

// --- SSE Event Types ---

interface SSEMessageStart {
  type: "message_start"
  message: { id: string; model: string; usage: { input_tokens: number; output_tokens: number } }
}

interface SSEContentBlockStart {
  type: "content_block_start"
  index: number
  content_block: { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: "thinking"; thinking: string }
}

interface SSEContentBlockDelta {
  type: "content_block_delta"
  index: number
  delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string } | { type: "thinking_delta"; thinking: string }
}

interface SSEMessageDelta {
  type: "message_delta"
  delta: { stop_reason: string | null }
  usage: { output_tokens: number }
}

type SSEEvent = SSEMessageStart | SSEContentBlockStart | SSEContentBlockDelta | SSEMessageDelta
  | { type: "content_block_stop"; index: number }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } }

// --- Message Format Conversion ---

function extractSystemMessage(messages: CanonicalMessage[]): { system: string | undefined; messages: CanonicalMessage[] } {
  const systemMessages: string[] = []
  const rest: CanonicalMessage[] = []

  for (const msg of messages) {
    if (msg.role === "system") {
      if (msg.content) systemMessages.push(msg.content)
    } else {
      rest.push(msg)
    }
  }

  return {
    system: systemMessages.length > 0 ? systemMessages.join("\n\n") : undefined,
    messages: rest,
  }
}

function toAnthropicMessages(messages: CanonicalMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = []

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({
        role: "user",
        content: [{ type: "text", text: msg.content ?? "" }],
      })
    } else if (msg.role === "assistant") {
      const blocks: AnthropicContentBlock[] = []

      if (msg.content) {
        blocks.push({ type: "text", text: msg.content })
      }

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input: unknown
          try {
            input = JSON.parse(tc.function.arguments)
          } catch {
            throw new Error(`Malformed tool arguments for ${tc.function.name}: ${tc.function.arguments.slice(0, 100)}`)
          }
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          })
        }
      }

      if (blocks.length > 0) {
        result.push({ role: "assistant", content: blocks })
      }
    } else if (msg.role === "tool") {
      // Tool results are user-role messages with tool_result content blocks
      // Merge consecutive tool results into one user message
      const lastMsg = result[result.length - 1]
      if (!msg.tool_call_id) {
        throw new Error("Tool result message missing tool_call_id — cannot map to Anthropic tool_result block")
      }
      const toolBlock: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: msg.content ?? "",
      }

      if (lastMsg?.role === "user" && lastMsg.content.some(b => b.type === "tool_result")) {
        // Merge into existing tool_result user message
        lastMsg.content.push(toolBlock)
      } else {
        result.push({ role: "user", content: [toolBlock] })
      }
    }
  }

  return result
}

function toAnthropicTools(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }))
}

function mapToolChoice(choice: CompletionOptions["tool_choice"]): AnthropicRequest["tool_choice"] {
  if (!choice || choice === "auto") return { type: "auto" }
  if (choice === "required") return { type: "any" }
  if (choice === "none") return undefined // Anthropic: omit tool_choice to disable
  return { type: "auto" }
}

function mapStopReason(reason: string | null): "stop" | "tool_calls" | "length" {
  if (reason === "tool_use") return "tool_calls"
  if (reason === "max_tokens") return "length"
  return "stop" // end_turn, stop_sequence, null
}

function extractToolCalls(content: AnthropicContentBlock[]): ToolCall[] | null {
  const calls: ToolCall[] = []
  for (const block of content) {
    if (block.type === "tool_use") {
      calls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      })
    }
  }
  return calls.length > 0 ? calls : null
}

function extractTextContent(content: AnthropicContentBlock[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map(b => b.text)
    .join("")
}

function extractThinking(content: AnthropicContentBlock[]): string | null {
  const thinking = content
    .filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking")
    .map(b => b.thinking)
    .join("")
  return thinking || null
}

// --- AnthropicAdapter ---

const DEFAULT_MAX_TOKENS = 4096
const ANTHROPIC_API_VERSION = "2023-06-01"
const ANTHROPIC_RETRYABLE_CODES = [529] // Anthropic-specific overloaded status

export class AnthropicAdapter implements ModelPortBase, ModelPortStreaming {
  private baseUrl: string
  private apiKey: string
  private model: string
  private modelCapabilities: ModelCapabilities
  private retryPolicy: RetryPolicy
  private defaultMaxTokens: number

  constructor(
    resolvedModel: ResolvedModel,
    providerConfig: ProviderEntry,
  ) {
    this.baseUrl = (providerConfig.options.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "")
    this.apiKey = providerConfig.options.apiKey ?? ""
    this.model = resolvedModel.modelId
    const modelEntry = providerConfig.models.get(resolvedModel.modelId)
    this.modelCapabilities = modelEntry?.capabilities ?? {
      tool_calling: true,
      thinking_traces: true,
      vision: true,
      streaming: true,
    }
    this.retryPolicy = providerConfig.retryPolicy ?? DEFAULT_RETRY_POLICY
    this.defaultMaxTokens = modelEntry?.limit.output ?? DEFAULT_MAX_TOKENS
  }

  capabilities(): ModelCapabilities {
    return this.modelCapabilities
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now()
    try {
      // Lightweight completion to verify key validity
      const res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1,
          messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
        }),
      })
      return {
        healthy: res.ok || res.status === 429, // 429 = rate limited but key is valid
        latency_ms: Date.now() - start,
      }
    } catch {
      return { healthy: false, latency_ms: Date.now() - start }
    }
  }

  /**
   * Non-streaming completion via Anthropic Messages API.
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const start = Date.now()
    const anthropicReq = this.buildRequest(request, false)
    const body = JSON.stringify(anthropicReq)

    let lastError: Error | null = null
    const maxRetries = this.retryPolicy.maxRetries
    const retryableCodes = new Set([...this.retryPolicy.retryableStatusCodes, ...ANTHROPIC_RETRYABLE_CODES])

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.backoff(attempt)
        await sleep(delay)
      }

      let res: Response
      try {
        res = await fetch(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers: this.headers(),
          body,
        })
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt === maxRetries) break
        continue
      }

      if (res.ok) {
        const data = (await res.json()) as AnthropicResponse
        return this.toCompletionResult(data, request.metadata.trace_id, Date.now() - start)
      }

      if (!retryableCodes.has(res.status)) {
        const errBody = await res.text().catch(() => "")
        throw new Error(`Anthropic API error ${res.status}: ${errBody.slice(0, 200)}`)
      }

      lastError = new Error(`Anthropic API error ${res.status}`)
    }

    throw lastError ?? new Error("Anthropic adapter: all retries exhausted")
  }

  /**
   * Streaming completion via Anthropic Messages API SSE.
   */
  async *stream(
    request: CompletionRequest,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<StreamChunk> {
    const abortController = new AbortController()
    let completed = false

    if (options?.signal) {
      if (options.signal.aborted) {
        abortController.abort()
      } else {
        options.signal.addEventListener("abort", () => abortController.abort(), { once: true })
      }
    }

    try {
      const anthropicReq = this.buildRequest(request, true)
      const body = JSON.stringify(anthropicReq)

      const res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: this.headers(),
        body,
        signal: abortController.signal,
      })

      if (!res.ok) {
        const errBody = await res.text().catch(() => "")
        yield { event: "error", data: { code: `ANTHROPIC_${res.status}`, message: errBody.slice(0, 500) } }
        return
      }

      if (!res.body) {
        yield { event: "error", data: { code: "ANTHROPIC_STREAM_ERROR", message: "Response body is null" } }
        return
      }

      // Track state for assembling tool calls and usage
      const toolCallState = new Map<number, { id: string; name: string; arguments: string }>()
      let inputTokens = 0
      let outputTokens = 0
      let thinkingBuffer = ""

      for await (const event of this.parseSSE(res.body)) {
        switch (event.type) {
          case "message_start":
            inputTokens = event.message.usage.input_tokens
            break

          case "content_block_start":
            if (event.content_block.type === "tool_use") {
              toolCallState.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                arguments: "",
              })
              yield {
                event: "tool_call",
                data: {
                  index: event.index,
                  id: event.content_block.id,
                  function: { name: event.content_block.name, arguments: "" },
                },
              }
            }
            break

          case "content_block_delta":
            if (event.delta.type === "text_delta") {
              yield { event: "chunk", data: { delta: event.delta.text, tool_calls: null } }
            } else if (event.delta.type === "input_json_delta") {
              const state = toolCallState.get(event.index)
              if (state) {
                state.arguments += event.delta.partial_json
                yield {
                  event: "tool_call",
                  data: {
                    index: event.index,
                    function: { arguments: event.delta.partial_json },
                  },
                }
              }
            } else if (event.delta.type === "thinking_delta") {
              thinkingBuffer += event.delta.thinking
            }
            break

          case "message_delta":
            outputTokens = event.usage.output_tokens
            // Emit accumulated thinking traces before usage/done
            if (thinkingBuffer) {
              yield { event: "thinking", data: { thinking: thinkingBuffer } }
              thinkingBuffer = ""
            }
            yield {
              event: "usage",
              data: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                reasoning_tokens: 0, // Anthropic doesn't separate reasoning tokens in API
              },
            }
            yield {
              event: "done",
              data: { finish_reason: mapStopReason(event.delta.stop_reason) },
            }
            break

          case "error":
            yield {
              event: "error",
              data: { code: event.error.type, message: event.error.message },
            }
            break

          // content_block_stop, message_stop, ping — no action
        }
      }
      completed = true
    } catch (err) {
      if (!abortController.signal.aborted) {
        yield {
          event: "error",
          data: { code: "ANTHROPIC_STREAM_ERROR", message: String(err) },
        }
      }
    } finally {
      if (!completed) {
        abortController.abort()
      }
    }
  }

  // --- Private ---

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    }
  }

  private buildRequest(request: CompletionRequest, stream: boolean): AnthropicRequest {
    const { system, messages } = extractSystemMessage(request.messages)
    const anthropicMessages = toAnthropicMessages(messages)

    const req: AnthropicRequest = {
      model: this.model,
      max_tokens: request.options.max_tokens ?? this.defaultMaxTokens,
      messages: anthropicMessages,
      stream,
    }

    if (system) req.system = system
    if (request.options.temperature !== undefined) req.temperature = request.options.temperature
    if (request.options.top_p !== undefined) req.top_p = request.options.top_p
    if (request.options.stop?.length) req.stop_sequences = request.options.stop

    if (request.tools?.length && request.options.tool_choice !== "none") {
      req.tools = toAnthropicTools(request.tools)
      req.tool_choice = mapToolChoice(request.options.tool_choice)
    }

    return req
  }

  private toCompletionResult(data: AnthropicResponse, traceId: string, latencyMs: number): CompletionResult {
    return {
      content: extractTextContent(data.content),
      thinking: extractThinking(data.content),
      tool_calls: extractToolCalls(data.content),
      usage: {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        reasoning_tokens: 0,
      },
      metadata: {
        model: data.model,
        provider_request_id: data.id,
        latency_ms: latencyMs,
        trace_id: traceId,
      },
    }
  }

  private backoff(attempt: number): number {
    const base = this.retryPolicy.baseDelayMs * Math.pow(2, attempt - 1)
    const capped = Math.min(base, this.retryPolicy.maxDelayMs)
    const jitter = capped * (this.retryPolicy.jitterPercent / 100) * Math.random()
    return capped + jitter
  }

  /**
   * Parse Anthropic SSE stream into typed events.
   */
  private async *parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
    const decoder = new TextDecoder()
    let buffer = ""
    let eventType = ""
    let dataBuffer = ""

    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "") // handle CRLF
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          let data = line.slice(5)
          if (data.startsWith(" ")) data = data.slice(1)
          dataBuffer += (dataBuffer ? "\n" : "") + data
        } else if (line === "") {
          // Empty line = event boundary
          if (eventType && dataBuffer) {
            try {
              const parsed = JSON.parse(dataBuffer) as SSEEvent
              yield parsed
            } catch {
              // Skip unparseable events
            }
          }
          eventType = ""
          dataBuffer = ""
        }
      }
    }

    // Flush decoder tail and any final event without trailing blank line
    buffer += decoder.decode()
    if (buffer.trim()) {
      const finalLines = buffer.split("\n")
      for (const rawLine of finalLines) {
        const line = rawLine.replace(/\r$/, "")
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          let data = line.slice(5)
          if (data.startsWith(" ")) data = data.slice(1)
          dataBuffer += (dataBuffer ? "\n" : "") + data
        }
      }
    }
    if (eventType && dataBuffer) {
      try {
        const parsed = JSON.parse(dataBuffer) as SSEEvent
        yield parsed
      } catch {
        // Skip unparseable final event
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
