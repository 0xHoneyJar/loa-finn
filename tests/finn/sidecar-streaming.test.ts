// tests/finn/sidecar-streaming.test.ts — SidecarModelAdapter streaming tests (T-2.4)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { SidecarClient, SidecarModelAdapter } from "../../src/hounfour/sidecar-client.js"
import type { CompletionRequest, ProviderEntry, ResolvedModel, StreamChunk } from "../../src/hounfour/types.js"

// --- Helpers ---

/** Encode a string as SSE bytes */
function sseBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Create a ReadableStream from SSE text */
function sseStream(text: string): ReadableStream<Uint8Array> {
  const bytes = sseBytes(text)
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

/** Build a minimal CompletionRequest for testing */
function makeRequest(overrides?: Partial<CompletionRequest>): CompletionRequest {
  return {
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    options: {},
    metadata: { trace_id: "test-trace-001", turn_id: "turn-1" },
    ...overrides,
  }
}

/** Build test fixtures */
function makeFixtures() {
  const hmacConfig = { secret: "test-secret-key" }
  const client = new SidecarClient({ baseUrl: "http://127.0.0.1:3001", hmac: hmacConfig })
  const resolvedModel: ResolvedModel = {
    provider: "test-provider",
    modelId: "test-model",
  }
  const providerConfig: ProviderEntry = {
    name: "test-provider",
    type: "openai-compatible",
    models: new Map([
      ["test-model", {
        capabilities: { tool_calling: true, thinking_traces: false, vision: false, streaming: true },
      }],
    ]),
    options: { baseURL: "http://upstream:8080/v1", apiKey: "sk-test" },
  } as unknown as ProviderEntry
  const adapter = new SidecarModelAdapter(client, resolvedModel, providerConfig)
  return { client, adapter, resolvedModel, providerConfig }
}

// --- Tests ---

describe("SidecarModelAdapter.stream", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("yields StreamChunks from a successful SSE response", async () => {
    const sseText = [
      'event: chunk\ndata: {"delta":"Hello","tool_calls":null}\n\n',
      'event: chunk\ndata: {"delta":" world","tool_calls":null}\n\n',
      'event: usage\ndata: {"prompt_tokens":5,"completion_tokens":2,"reasoning_tokens":0}\n\n',
      'event: done\ndata: {"finish_reason":"stop"}\n\n',
    ].join("")

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: sseStream(sseText),
    })

    const { adapter } = makeFixtures()
    const chunks = await collect(adapter.stream(makeRequest()))

    expect(chunks).toHaveLength(4)
    expect(chunks[0]).toEqual({ event: "chunk", data: { delta: "Hello", tool_calls: null } })
    expect(chunks[1]).toEqual({ event: "chunk", data: { delta: " world", tool_calls: null } })
    expect(chunks[2].event).toBe("usage")
    expect(chunks[3]).toEqual({ event: "done", data: { finish_reason: "stop" } })
  })

  it("yields tool_call events from SSE stream", async () => {
    const sseText = [
      'event: tool_call\ndata: {"index":0,"id":"call_abc","function":{"name":"get_weather","arguments":""}}\n\n',
      'event: tool_call\ndata: {"index":0,"function":{"arguments":"{\\"city\\": \\"NYC\\"}"}}\n\n',
      'event: done\ndata: {"finish_reason":"tool_calls"}\n\n',
    ].join("")

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: sseStream(sseText),
    })

    const { adapter } = makeFixtures()
    const chunks = await collect(adapter.stream(makeRequest()))

    expect(chunks).toHaveLength(3)
    expect(chunks[0].event).toBe("tool_call")
    expect((chunks[0].data as any).id).toBe("call_abc")
    expect(chunks[1].event).toBe("tool_call")
    expect(chunks[2]).toEqual({ event: "done", data: { finish_reason: "tool_calls" } })
  })

  it("yields error event on non-200 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers({}),
      text: async () => "Bad Gateway",
    })

    const { adapter } = makeFixtures()
    const chunks = await collect(adapter.stream(makeRequest()))

    expect(chunks).toHaveLength(1)
    expect(chunks[0].event).toBe("error")
    expect((chunks[0].data as any).code).toBe("SIDECAR_502")
    expect((chunks[0].data as any).message).toBe("Bad Gateway")
  })

  it("yields error event on wrong content-type", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: sseStream("{}"),
    })

    const { adapter } = makeFixtures()
    const chunks = await collect(adapter.stream(makeRequest()))

    expect(chunks).toHaveLength(1)
    expect(chunks[0].event).toBe("error")
    expect((chunks[0].data as any).code).toBe("INVALID_CONTENT_TYPE")
  })

  it("yields error event on null response body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: null,
    })

    const { adapter } = makeFixtures()
    const chunks = await collect(adapter.stream(makeRequest()))

    expect(chunks).toHaveLength(1)
    expect(chunks[0].event).toBe("error")
    expect((chunks[0].data as any).code).toBe("SIDECAR_STREAM_ERROR")
    expect((chunks[0].data as any).message).toBe("Response body is null")
  })

  it("yields error event on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"))

    const { adapter } = makeFixtures()
    const chunks = await collect(adapter.stream(makeRequest()))

    expect(chunks).toHaveLength(1)
    expect(chunks[0].event).toBe("error")
    expect((chunks[0].data as any).code).toBe("SIDECAR_STREAM_ERROR")
    expect((chunks[0].data as any).message).toContain("Connection refused")
  })

  it("signs request with HMAC for /invoke/stream path", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: sseStream('event: done\ndata: {"finish_reason":"stop"}\n\n'),
    })

    const { adapter } = makeFixtures()
    await collect(adapter.stream(makeRequest()))

    const fetchCall = (globalThis.fetch as any).mock.calls[0]
    const url = fetchCall[0] as string
    const opts = fetchCall[1] as RequestInit

    expect(url).toBe("http://127.0.0.1:3001/invoke/stream")
    expect(opts.method).toBe("POST")
    expect((opts.headers as any)["x-cheval-signature"]).toBeTruthy()
    expect((opts.headers as any)["x-cheval-nonce"]).toBeTruthy()
    expect((opts.headers as any)["x-cheval-issued-at"]).toBeTruthy()
    expect((opts.headers as any)["x-cheval-trace-id"]).toBe("test-trace-001")
  })

  it("does not yield error when external signal aborts", async () => {
    const controller = new AbortController()

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      // Simulate abort during fetch
      controller.abort()
      throw new DOMException("The operation was aborted", "AbortError")
    })

    const { adapter } = makeFixtures()
    const chunks = await collect(adapter.stream(makeRequest(), { signal: controller.signal }))

    // Should NOT yield error when aborted externally — abort is intentional
    expect(chunks).toHaveLength(0)
  })

  it("handles pre-aborted signal", async () => {
    const controller = new AbortController()
    controller.abort()

    globalThis.fetch = vi.fn().mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    )

    const { adapter } = makeFixtures()
    const chunks = await collect(adapter.stream(makeRequest(), { signal: controller.signal }))

    // Pre-aborted — fetch should fail, but no error event since abort is intentional
    expect(chunks).toHaveLength(0)
  })
})

describe("SidecarModelAdapter.capabilities", () => {
  it("reports streaming: true", () => {
    const { adapter } = makeFixtures()
    const caps = adapter.capabilities()
    expect(caps.streaming).toBe(true)
    expect(caps.tool_calling).toBe(true)
  })
})

describe("SidecarClient accessors", () => {
  it("getBaseUrl returns configured base URL", () => {
    const client = new SidecarClient({
      baseUrl: "http://127.0.0.1:9999",
      hmac: { secret: "s" },
    })
    expect(client.getBaseUrl()).toBe("http://127.0.0.1:9999")
  })

  it("getHmacSecret returns configured secret", () => {
    const client = new SidecarClient({
      baseUrl: "http://127.0.0.1:3001",
      hmac: { secret: "my-secret" },
    })
    expect(client.getHmacSecret()).toBe("my-secret")
  })
})
