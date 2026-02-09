// tests/finn/native-adapter.test.ts — AnthropicAdapter tests (T-B.2)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { AnthropicAdapter } from "../../src/hounfour/native-adapter.js"
import type { CompletionRequest, ProviderEntry, ResolvedModel, StreamChunk } from "../../src/hounfour/types.js"

// --- Helpers ---

function makeResolvedModel(): ResolvedModel {
  return { provider: "anthropic-direct", modelId: "claude-opus-4-6" }
}

function makeProviderConfig(overrides?: Partial<ProviderEntry>): ProviderEntry {
  return {
    name: "anthropic-direct",
    type: "claude-code",
    options: { baseURL: "https://api.anthropic.com", apiKey: "sk-ant-test-key" },
    models: new Map([
      ["claude-opus-4-6", {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        capabilities: { tool_calling: true, thinking_traces: true, vision: true, streaming: true },
        limit: { context: 200_000, output: 4096 },
      }],
    ]),
    ...overrides,
  } as ProviderEntry
}

function makeRequest(overrides?: Partial<CompletionRequest>): CompletionRequest {
  return {
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    options: {},
    metadata: { agent: "test", tenant_id: "local", nft_id: "", trace_id: "trace-001" },
    ...overrides,
  }
}

function anthropicResponse(content: string, overrides?: Record<string, unknown>) {
  return {
    id: "msg_test_001",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: content }],
    model: "claude-opus-4-6",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  }
}

function toolUseResponse() {
  return {
    id: "msg_test_002",
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "I'll look that up." },
      { type: "tool_use", id: "toolu_01", name: "search", input: { query: "hello world" } },
    ],
    model: "claude-opus-4-6",
    stop_reason: "tool_use",
    usage: { input_tokens: 15, output_tokens: 20 },
  }
}

function thinkingResponse() {
  return {
    id: "msg_test_003",
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think about this carefully..." },
      { type: "text", text: "Here is my answer." },
    ],
    model: "claude-opus-4-6",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 30 },
  }
}

/** Create a ReadableStream from SSE text */
function sseStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** Collect all chunks from an async generator */
async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of gen) chunks.push(chunk)
  return chunks
}

// --- Tests ---

describe("AnthropicAdapter", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // --- capabilities ---

  describe("capabilities", () => {
    it("returns model capabilities from provider config", () => {
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const caps = adapter.capabilities()
      expect(caps.tool_calling).toBe(true)
      expect(caps.thinking_traces).toBe(true)
      expect(caps.streaming).toBe(true)
    })

    it("returns defaults when model not found in provider config", () => {
      const adapter = new AnthropicAdapter(
        { provider: "anthropic-direct", modelId: "unknown-model" },
        makeProviderConfig(),
      )
      const caps = adapter.capabilities()
      expect(caps.tool_calling).toBe(true)
    })
  })

  // --- healthCheck ---

  describe("healthCheck", () => {
    it("returns healthy on 200 response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const health = await adapter.healthCheck()
      expect(health.healthy).toBe(true)
      expect(health.latency_ms).toBeGreaterThanOrEqual(0)
    })

    it("returns healthy on 429 (rate limited but key valid)", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 })
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const health = await adapter.healthCheck()
      expect(health.healthy).toBe(true)
    })

    it("returns unhealthy on 401 (invalid key)", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 })
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const health = await adapter.healthCheck()
      expect(health.healthy).toBe(false)
    })

    it("returns unhealthy on network error", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const health = await adapter.healthCheck()
      expect(health.healthy).toBe(false)
    })

    it("sends correct headers", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
      globalThis.fetch = fetchMock
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      await adapter.healthCheck()

      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe("https://api.anthropic.com/v1/messages")
      expect(opts.headers["x-api-key"]).toBe("sk-ant-test-key")
      expect(opts.headers["anthropic-version"]).toBe("2023-06-01")
      expect(opts.headers["Content-Type"]).toBe("application/json")
    })
  })

  // --- complete ---

  describe("complete", () => {
    it("sends correct request format and returns CompletionResult", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => anthropicResponse("Hello!"),
      })
      globalThis.fetch = fetchMock
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const result = await adapter.complete(makeRequest())

      expect(result.content).toBe("Hello!")
      expect(result.thinking).toBeNull()
      expect(result.tool_calls).toBeNull()
      expect(result.usage.prompt_tokens).toBe(10)
      expect(result.usage.completion_tokens).toBe(5)
      expect(result.metadata.model).toBe("claude-opus-4-6")
      expect(result.metadata.provider_request_id).toBe("msg_test_001")
      expect(result.metadata.trace_id).toBe("trace-001")
      expect(result.metadata.latency_ms).toBeGreaterThanOrEqual(0)
    })

    it("extracts system message to top-level parameter", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => anthropicResponse("Hi"),
      })
      globalThis.fetch = fetchMock
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      await adapter.complete(makeRequest({
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
        ],
      }))

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.system).toBe("You are helpful.")
      expect(body.messages).toHaveLength(1)
      expect(body.messages[0].role).toBe("user")
    })

    it("merges multiple system messages", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => anthropicResponse("Hi"),
      })
      globalThis.fetch = fetchMock
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      await adapter.complete(makeRequest({
        messages: [
          { role: "system", content: "Be helpful." },
          { role: "system", content: "Be concise." },
          { role: "user", content: "Hello" },
        ],
      }))

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.system).toBe("Be helpful.\n\nBe concise.")
    })

    it("converts tool definitions to Anthropic format", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => anthropicResponse("ok"),
      })
      globalThis.fetch = fetchMock
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      await adapter.complete(makeRequest({
        tools: [{
          type: "function",
          function: {
            name: "search",
            description: "Search for info",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        }],
        options: { tool_choice: "auto" },
      }))

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.tools).toHaveLength(1)
      expect(body.tools[0].name).toBe("search")
      expect(body.tools[0].description).toBe("Search for info")
      expect(body.tools[0].input_schema).toEqual({ type: "object", properties: { query: { type: "string" } } })
      expect(body.tool_choice).toEqual({ type: "auto" })
    })

    it("extracts tool calls from response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => toolUseResponse(),
      })
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const result = await adapter.complete(makeRequest())

      expect(result.content).toBe("I'll look that up.")
      expect(result.tool_calls).toHaveLength(1)
      expect(result.tool_calls![0].id).toBe("toolu_01")
      expect(result.tool_calls![0].type).toBe("function")
      expect(result.tool_calls![0].function.name).toBe("search")
      expect(JSON.parse(result.tool_calls![0].function.arguments)).toEqual({ query: "hello world" })
    })

    it("extracts thinking content from response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => thinkingResponse(),
      })
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const result = await adapter.complete(makeRequest())

      expect(result.thinking).toBe("Let me think about this carefully...")
      expect(result.content).toBe("Here is my answer.")
    })

    it("converts tool result messages to user role with tool_result blocks", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => anthropicResponse("Based on the search results..."),
      })
      globalThis.fetch = fetchMock
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      await adapter.complete(makeRequest({
        messages: [
          { role: "user", content: "Search for something" },
          { role: "assistant", content: null, tool_calls: [{ id: "toolu_01", type: "function", function: { name: "search", arguments: '{"q":"test"}' } }] },
          { role: "tool", content: "result: found it", tool_call_id: "toolu_01" },
        ],
      }))

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      // Tool result should be user role
      const toolMsg = body.messages[2]
      expect(toolMsg.role).toBe("user")
      expect(toolMsg.content[0].type).toBe("tool_result")
      expect(toolMsg.content[0].tool_use_id).toBe("toolu_01")
      expect(toolMsg.content[0].content).toBe("result: found it")
    })

    it("maps tool_choice 'required' to 'any'", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => anthropicResponse("ok"),
      })
      globalThis.fetch = fetchMock
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      await adapter.complete(makeRequest({
        tools: [{
          type: "function",
          function: { name: "test", description: "test", parameters: {} },
        }],
        options: { tool_choice: "required" },
      }))

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.tool_choice).toEqual({ type: "any" })
    })

    it("omits tool_choice for 'none'", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => anthropicResponse("ok"),
      })
      globalThis.fetch = fetchMock
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      await adapter.complete(makeRequest({
        tools: [{
          type: "function",
          function: { name: "test", description: "test", parameters: {} },
        }],
        options: { tool_choice: "none" },
      }))

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.tool_choice).toBeUndefined()
    })

    it("passes temperature, top_p, and stop_sequences", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => anthropicResponse("ok"),
      })
      globalThis.fetch = fetchMock
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      await adapter.complete(makeRequest({
        options: { temperature: 0.7, top_p: 0.9, stop: ["END"] },
      }))

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.temperature).toBe(0.7)
      expect(body.top_p).toBe(0.9)
      expect(body.stop_sequences).toEqual(["END"])
    })

    it("uses default max_tokens from model config", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => anthropicResponse("ok"),
      })
      globalThis.fetch = fetchMock
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      await adapter.complete(makeRequest())

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.max_tokens).toBe(4096)
    })

    it("overrides max_tokens from request options", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => anthropicResponse("ok"),
      })
      globalThis.fetch = fetchMock
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      await adapter.complete(makeRequest({ options: { max_tokens: 1024 } }))

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.max_tokens).toBe(1024)
    })

    // --- Retry behavior ---

    it("retries on 429 and succeeds", async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return { ok: false, status: 429, text: async () => "rate limited" }
        }
        return { ok: true, json: async () => anthropicResponse("ok") }
      })

      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig({
        retryPolicy: {
          maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, jitterPercent: 0,
          retryableStatusCodes: [429, 500, 502, 503, 529],
          retryableErrors: [],
        },
      } as Partial<ProviderEntry>))
      const result = await adapter.complete(makeRequest())

      expect(result.content).toBe("ok")
      expect(callCount).toBe(2)
    })

    it("retries on 529 (Anthropic overloaded)", async () => {
      let callCount = 0
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return { ok: false, status: 529, text: async () => "overloaded" }
        }
        return { ok: true, json: async () => anthropicResponse("ok") }
      })

      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig({
        retryPolicy: {
          maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, jitterPercent: 0,
          retryableStatusCodes: [429, 500, 502, 503, 529],
          retryableErrors: [],
        },
      } as Partial<ProviderEntry>))
      const result = await adapter.complete(makeRequest())

      expect(result.content).toBe("ok")
      expect(callCount).toBe(2)
    })

    it("throws immediately on 400 (non-retryable)", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false, status: 400,
        text: async () => "invalid request body",
      })

      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig({
        retryPolicy: {
          maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, jitterPercent: 0,
          retryableStatusCodes: [429, 500, 502, 503, 529],
          retryableErrors: [],
        },
      } as Partial<ProviderEntry>))

      await expect(adapter.complete(makeRequest())).rejects.toThrow("Anthropic API error 400")
    })

    it("throws immediately on 401 (non-retryable)", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false, status: 401,
        text: async () => "invalid api key",
      })

      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      await expect(adapter.complete(makeRequest())).rejects.toThrow("Anthropic API error 401")
    })

    it("exhausts retries and throws", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false, status: 500,
        text: async () => "internal server error",
      })

      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig({
        retryPolicy: {
          maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5, jitterPercent: 0,
          retryableStatusCodes: [429, 500, 502, 503, 529],
          retryableErrors: [],
        },
      } as Partial<ProviderEntry>))

      await expect(adapter.complete(makeRequest())).rejects.toThrow("Anthropic API error 500")
    })

    // --- Stop reason mapping ---

    it("maps end_turn to stop", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => anthropicResponse("ok", { stop_reason: "end_turn" }),
      })
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const result = await adapter.complete(makeRequest())
      // CompletionResult doesn't have finish_reason, but the mapping is tested via stream
      expect(result.content).toBe("ok")
    })

    it("maps tool_use stop reason to tool_calls", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => toolUseResponse(),
      })
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const result = await adapter.complete(makeRequest())
      expect(result.tool_calls).not.toBeNull()
    })
  })

  // --- stream ---

  describe("stream", () => {
    it("yields text chunks from SSE events", async () => {
      const sseText = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-6","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join("")

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: sseStream(sseText),
      })

      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const chunks = await collect(adapter.stream(makeRequest()))

      const textChunks = chunks.filter(c => c.event === "chunk")
      expect(textChunks).toHaveLength(2)
      expect((textChunks[0] as any).data.delta).toBe("Hello")
      expect((textChunks[1] as any).data.delta).toBe(" world")

      const usageChunks = chunks.filter(c => c.event === "usage")
      expect(usageChunks).toHaveLength(1)
      expect((usageChunks[0] as any).data.prompt_tokens).toBe(10)
      expect((usageChunks[0] as any).data.completion_tokens).toBe(5)

      const doneChunks = chunks.filter(c => c.event === "done")
      expect(doneChunks).toHaveLength(1)
      expect((doneChunks[0] as any).data.finish_reason).toBe("stop")
    })

    it("yields tool call events from SSE", async () => {
      const sseText = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","model":"claude-opus-4-6","usage":{"input_tokens":15,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"search","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"hello\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":10}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join("")

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: sseStream(sseText),
      })

      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const chunks = await collect(adapter.stream(makeRequest()))

      const toolCallChunks = chunks.filter(c => c.event === "tool_call")
      expect(toolCallChunks.length).toBeGreaterThanOrEqual(2)
      // First tool_call chunk: content_block_start with id and name
      expect((toolCallChunks[0] as any).data.id).toBe("toolu_01")
      expect((toolCallChunks[0] as any).data.function.name).toBe("search")

      const doneChunks = chunks.filter(c => c.event === "done")
      expect(doneChunks).toHaveLength(1)
      expect((doneChunks[0] as any).data.finish_reason).toBe("tool_calls")
    })

    it("yields error event on non-ok response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "invalid api key",
      })

      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const chunks = await collect(adapter.stream(makeRequest()))

      expect(chunks).toHaveLength(1)
      expect(chunks[0].event).toBe("error")
      expect((chunks[0] as any).data.code).toBe("ANTHROPIC_401")
    })

    it("yields error event on null body", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: null,
      })

      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const chunks = await collect(adapter.stream(makeRequest()))

      expect(chunks).toHaveLength(1)
      expect(chunks[0].event).toBe("error")
      expect((chunks[0] as any).data.code).toBe("ANTHROPIC_STREAM_ERROR")
    })

    it("respects abort signal (pre-aborted)", async () => {
      const abortController = new AbortController()
      abortController.abort()

      globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"))

      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const chunks = await collect(adapter.stream(makeRequest(), { signal: abortController.signal }))

      // Should not yield error when abort is intentional
      const errorChunks = chunks.filter(c => c.event === "error")
      expect(errorChunks).toHaveLength(0)
    })

    it("propagates abort signal to fetch", async () => {
      const fetchMock = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        // Verify signal is passed
        expect(opts.signal).toBeDefined()
        return {
          ok: true,
          body: sseStream(
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_3","model":"claude-opus-4-6","usage":{"input_tokens":5,"output_tokens":0}}}\n\n' +
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n'
          ),
        }
      })
      globalThis.fetch = fetchMock

      const abortController = new AbortController()
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      await collect(adapter.stream(makeRequest(), { signal: abortController.signal }))

      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it("handles SSE error event from Anthropic", async () => {
      const sseText = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_4","model":"claude-opus-4-6","usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ].join("")

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: sseStream(sseText),
      })

      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const chunks = await collect(adapter.stream(makeRequest()))

      const errorChunks = chunks.filter(c => c.event === "error")
      expect(errorChunks).toHaveLength(1)
      expect((errorChunks[0] as any).data.code).toBe("overloaded_error")
      expect((errorChunks[0] as any).data.message).toBe("Overloaded")
    })

    it("sets stream: true in request body", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        body: sseStream(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_5","model":"claude-opus-4-6","usage":{"input_tokens":5,"output_tokens":0}}}\n\n' +
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        ),
      })
      globalThis.fetch = fetchMock

      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      await collect(adapter.stream(makeRequest()))

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.stream).toBe(true)
    })

    it("maps max_tokens stop reason to length", async () => {
      const sseText = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_6","model":"claude-opus-4-6","usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"truncated"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":100}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join("")

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: sseStream(sseText),
      })

      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      const chunks = await collect(adapter.stream(makeRequest()))

      const doneChunks = chunks.filter(c => c.event === "done")
      expect(doneChunks).toHaveLength(1)
      expect((doneChunks[0] as any).data.finish_reason).toBe("length")
    })
  })

  // --- Message format conversion ---

  describe("message format conversion", () => {
    it("converts assistant tool_call messages to tool_use content blocks", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => anthropicResponse("ok"),
      })
      globalThis.fetch = fetchMock
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      await adapter.complete(makeRequest({
        messages: [
          { role: "user", content: "Use the tool" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "tc_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"foo.txt"}' },
            }],
          },
          { role: "tool", content: "file contents here", tool_call_id: "tc_1" },
          { role: "user", content: "Thanks" },
        ],
      }))

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      // Assistant message should have tool_use block
      const assistantMsg = body.messages[1]
      expect(assistantMsg.role).toBe("assistant")
      expect(assistantMsg.content[0].type).toBe("tool_use")
      expect(assistantMsg.content[0].id).toBe("tc_1")
      expect(assistantMsg.content[0].name).toBe("read_file")
      expect(assistantMsg.content[0].input).toEqual({ path: "foo.txt" })
    })

    it("merges consecutive tool results into single user message", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => anthropicResponse("ok"),
      })
      globalThis.fetch = fetchMock
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig())
      await adapter.complete(makeRequest({
        messages: [
          { role: "user", content: "Use both tools" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "tc_1", type: "function", function: { name: "tool_a", arguments: "{}" } },
              { id: "tc_2", type: "function", function: { name: "tool_b", arguments: "{}" } },
            ],
          },
          { role: "tool", content: "result_a", tool_call_id: "tc_1" },
          { role: "tool", content: "result_b", tool_call_id: "tc_2" },
        ],
      }))

      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      // Two tool results should be merged into one user message
      const lastMsg = body.messages[2]
      expect(lastMsg.role).toBe("user")
      expect(lastMsg.content).toHaveLength(2)
      expect(lastMsg.content[0].type).toBe("tool_result")
      expect(lastMsg.content[0].tool_use_id).toBe("tc_1")
      expect(lastMsg.content[1].type).toBe("tool_result")
      expect(lastMsg.content[1].tool_use_id).toBe("tc_2")
    })

    it("strips trailing slash from baseURL", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => anthropicResponse("ok"),
      })
      globalThis.fetch = fetchMock
      const adapter = new AnthropicAdapter(makeResolvedModel(), makeProviderConfig({
        options: { baseURL: "https://api.anthropic.com///", apiKey: "sk-test" },
      } as Partial<ProviderEntry>))
      await adapter.complete(makeRequest())

      expect(fetchMock.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages")
    })
  })
})
