// tests/finn/byok-proxy.test.ts — BYOK Proxy Client Tests (T-C.2, T-C.5)
// Tests BYOKProxyClient: non-streaming, streaming, error handling, key-not-found fallback.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { BYOKProxyClient, BYOKKeyNotFoundError } from "../../src/hounfour/byok-proxy-client.js"
import type { CompletionRequest, StreamChunk } from "../../src/hounfour/types.js"

// --- Mock S2S JWT Signer ---

function createMockSigner() {
  return {
    signJWT: vi.fn().mockResolvedValue("mock-s2s-jwt-token"),
    signJWS: vi.fn().mockResolvedValue("mock-jws"),
    signPayload: vi.fn().mockResolvedValue("mock-jws-payload"),
    init: vi.fn().mockResolvedValue(undefined),
    getPublicJWK: vi.fn().mockReturnValue({}),
    getJWKS: vi.fn().mockReturnValue({ keys: [] }),
    get isReady() { return true },
  }
}

// --- Test Helpers ---

function makeRequest(overrides?: Partial<CompletionRequest>): CompletionRequest {
  return {
    messages: [{ role: "user", content: "Hello" }],
    options: { temperature: 0.7, max_tokens: 1024 },
    metadata: {
      agent: "test-agent",
      tenant_id: "community:thj",
      nft_id: "mibera:4269",
      trace_id: "test-trace-001",
    },
    ...overrides,
  }
}

function makeSSEStream(events: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const lines: string[] = []
  for (const ev of events) {
    lines.push(`event: ${ev.event}`)
    lines.push(`data: ${JSON.stringify(ev.data)}`)
    lines.push("") // blank line = event boundary
  }
  const payload = lines.join("\n") + "\n"
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

// --- Tests ---

describe("BYOKProxyClient", () => {
  let client: BYOKProxyClient
  let signer: ReturnType<typeof createMockSigner>
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    signer = createMockSigner()
    client = new BYOKProxyClient(
      "https://arrakis.example.com",
      signer as any,
      "openai",
      "gpt-4o",
    )
    fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // --- capabilities ---

  it("reports capabilities with tool_calling and streaming", () => {
    const caps = client.capabilities()
    expect(caps.tool_calling).toBe(true)
    expect(caps.streaming).toBe(true)
    expect(caps.vision).toBe(true)
  })

  // --- complete() ---

  describe("complete()", () => {
    it("sends ProxyInferenceRequest with S2S JWT auth", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        content: "Hello from BYOK proxy",
        thinking: null,
        tool_calls: null,
        usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 },
        metadata: { model: "gpt-4o", latency_ms: 200, trace_id: "test-trace-001" },
      }), { status: 200 }))

      const result = await client.complete(makeRequest())

      expect(result.content).toBe("Hello from BYOK proxy")
      expect(result.usage.prompt_tokens).toBe(10)
      expect(result.metadata.trace_id).toBe("test-trace-001")

      // Verify S2S JWT auth
      expect(signer.signJWT).toHaveBeenCalledWith({
        purpose: "byok-proxy",
        trace_id: "test-trace-001",
      })

      // Verify request body
      const [url, opts] = fetchSpy.mock.calls[0]
      expect(url).toBe("https://arrakis.example.com/internal/byok-proxy")
      expect(opts.headers.Authorization).toBe("Bearer mock-s2s-jwt-token")

      const body = JSON.parse(opts.body)
      expect(body.trace_id).toBe("test-trace-001")
      expect(body.tenant_id).toBe("community:thj")
      expect(body.provider).toBe("openai")
      expect(body.model).toBe("gpt-4o")
      expect(body.stream).toBe(false)
    })

    it("throws BYOKKeyNotFoundError on 404 with no_byok_key", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(
        JSON.stringify({ error: "no_byok_key", provider: "openai" }),
        { status: 404 },
      ))

      await expect(client.complete(makeRequest())).rejects.toThrow(BYOKKeyNotFoundError)

      // Second call to verify error properties
      fetchSpy.mockResolvedValueOnce(new Response(
        JSON.stringify({ error: "no_byok_key", provider: "openai" }),
        { status: 404 },
      ))

      try {
        await client.complete(makeRequest())
      } catch (err) {
        expect(err).toBeInstanceOf(BYOKKeyNotFoundError)
        expect((err as BYOKKeyNotFoundError).provider).toBe("openai")
        expect((err as BYOKKeyNotFoundError).tenantId).toBe("community:thj")
      }
    })

    it("throws generic error on non-200/non-404 response", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }))

      await expect(client.complete(makeRequest())).rejects.toThrow("BYOK proxy error 500")
    })

    it("includes max_tokens and temperature in proxy request", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        content: "response",
        thinking: null,
        tool_calls: null,
        usage: { prompt_tokens: 5, completion_tokens: 3, reasoning_tokens: 0 },
        metadata: { model: "gpt-4o", latency_ms: 100, trace_id: "t" },
      }), { status: 200 }))

      await client.complete(makeRequest({
        options: { temperature: 0.3, max_tokens: 2048 },
      }))

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
      expect(body.temperature).toBe(0.3)
      expect(body.max_tokens).toBe(2048)
    })

    it("never exposes plaintext key material in requests", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        content: "safe response",
        thinking: null,
        tool_calls: null,
        usage: { prompt_tokens: 5, completion_tokens: 3, reasoning_tokens: 0 },
        metadata: { model: "gpt-4o", latency_ms: 100, trace_id: "t" },
      }), { status: 200 }))

      await client.complete(makeRequest())

      // Verify the request body does not contain any key-like fields
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
      expect(body).not.toHaveProperty("api_key")
      expect(body).not.toHaveProperty("apiKey")
      expect(body).not.toHaveProperty("secret")
      expect(body).not.toHaveProperty("key")
    })
  })

  // --- stream() ---

  describe("stream()", () => {
    it("yields StreamChunk events from SSE", async () => {
      const sseBody = makeSSEStream([
        { event: "chunk", data: { event: "chunk", data: { delta: "Hello ", tool_calls: null } } },
        { event: "chunk", data: { event: "chunk", data: { delta: "world!", tool_calls: null } } },
        { event: "done", data: { event: "done", data: { finish_reason: "stop" } } },
      ])

      fetchSpy.mockResolvedValueOnce(new Response(sseBody, { status: 200 }))

      const chunks: StreamChunk[] = []
      for await (const chunk of client.stream(makeRequest())) {
        chunks.push(chunk)
      }

      expect(chunks).toHaveLength(3)
      expect(chunks[0].event).toBe("chunk")
      expect(chunks[2].event).toBe("done")
    })

    it("yields error on 404 (no BYOK key)", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(
        JSON.stringify({ error: "no_byok_key" }),
        { status: 404 },
      ))

      const chunks: StreamChunk[] = []
      for await (const chunk of client.stream(makeRequest())) {
        chunks.push(chunk)
      }

      expect(chunks).toHaveLength(1)
      expect(chunks[0].event).toBe("error")
      expect((chunks[0] as any).data.code).toBe("BYOK_KEY_NOT_FOUND")
    })

    it("yields error on 500 proxy error", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Server Error", { status: 500 }))

      const chunks: StreamChunk[] = []
      for await (const chunk of client.stream(makeRequest())) {
        chunks.push(chunk)
      }

      expect(chunks).toHaveLength(1)
      expect(chunks[0].event).toBe("error")
      expect((chunks[0] as any).data.code).toBe("BYOK_PROXY_500")
    })

    it("handles CRLF in SSE stream", async () => {
      const encoder = new TextEncoder()
      const payload = "event: chunk\r\ndata: {\"event\":\"chunk\",\"data\":{\"delta\":\"hi\",\"tool_calls\":null}}\r\n\r\n"
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(payload))
          controller.close()
        },
      })

      fetchSpy.mockResolvedValueOnce(new Response(body, { status: 200 }))

      const chunks: StreamChunk[] = []
      for await (const chunk of client.stream(makeRequest())) {
        chunks.push(chunk)
      }

      expect(chunks).toHaveLength(1)
      expect(chunks[0].event).toBe("chunk")
    })

    it("respects abort signal", async () => {
      const controller = new AbortController()
      controller.abort()

      fetchSpy.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"))

      // Should not throw — aborted streams just end
      const chunks: StreamChunk[] = []
      try {
        for await (const chunk of client.stream(makeRequest(), { signal: controller.signal })) {
          chunks.push(chunk)
        }
      } catch {
        // Aborted — expected
      }
    })
  })

  // --- healthCheck() ---

  describe("healthCheck()", () => {
    it("returns healthy on 200", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("ok", { status: 200 }))

      const status = await client.healthCheck()
      expect(status.healthy).toBe(true)
    })

    it("returns healthy on 404 (endpoint exists but no key)", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("not found", { status: 404 }))

      const status = await client.healthCheck()
      expect(status.healthy).toBe(true)
    })

    it("returns unhealthy on network error", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("Connection refused"))

      const status = await client.healthCheck()
      expect(status.healthy).toBe(false)
    })
  })
})
