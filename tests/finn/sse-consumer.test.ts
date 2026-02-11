// tests/finn/sse-consumer.test.ts — SSE consumer tests (T-2.1)

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseSSEBytes, parseChunk, parseSSE, type SSEEvent } from "../../src/hounfour/sse-consumer.js"
import type { StreamChunk } from "../../src/hounfour/types.js"

// --- Helpers ---

/** Convert a string to an AsyncIterable<Uint8Array> (single chunk) */
function toStream(text: string): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  return {
    [Symbol.asyncIterator]() {
      let done = false
      return {
        async next() {
          if (done) return { done: true, value: undefined }
          done = true
          return { done: false, value: bytes }
        },
      }
    },
  }
}

/** Split text into chunks of given size to simulate TCP fragmentation */
function toChunkedStream(text: string, chunkSize: number): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  const chunks: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(bytes.slice(i, i + chunkSize))
  }
  return {
    [Symbol.asyncIterator]() {
      let idx = 0
      return {
        async next() {
          if (idx >= chunks.length) return { done: true, value: undefined }
          return { done: false, value: chunks[idx++] }
        },
      }
    },
  }
}

/** Collect all items from an async generator */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of gen) items.push(item)
  return items
}

/** Load golden fixture file */
function loadFixture(name: string): string {
  return readFileSync(join(__dirname, "../fixtures/sse", name), "utf-8")
}

// --- parseSSEBytes tests ---

describe("parseSSEBytes", () => {
  it("parses basic SSE events", async () => {
    const raw = "event: chunk\ndata: {\"delta\":\"hi\"}\n\n"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe("chunk")
    expect(events[0].data).toBe('{"delta":"hi"}')
  })

  it("handles multiple events", async () => {
    const raw = "event: chunk\ndata: {\"delta\":\"a\"}\n\nevent: chunk\ndata: {\"delta\":\"b\"}\n\n"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events).toHaveLength(2)
    expect(events[0].data).toBe('{"delta":"a"}')
    expect(events[1].data).toBe('{"delta":"b"}')
  })

  it("normalizes CRLF line endings", async () => {
    const raw = "event: chunk\r\ndata: {\"delta\":\"hi\"}\r\n\r\n"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('{"delta":"hi"}')
  })

  it("normalizes bare CR line endings", async () => {
    const raw = "event: chunk\rdata: {\"delta\":\"hi\"}\r\r"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('{"delta":"hi"}')
  })

  it("handles multi-line data fields", async () => {
    const raw = "data: line1\ndata: line2\ndata: line3\n\n"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe("line1\nline2\nline3")
  })

  it("skips comment lines", async () => {
    const raw = ": this is a comment\nevent: chunk\ndata: {\"delta\":\"hi\"}\n\n"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe("chunk")
  })

  it("uses 'message' as default event type", async () => {
    const raw = "data: hello\n\n"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe("message")
  })

  it("parses id field", async () => {
    const raw = "id: 42\ndata: test\n\n"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events[0].id).toBe("42")
  })

  it("ignores id with NULL character", async () => {
    const raw = "id: bad\0id\ndata: test\n\n"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events[0].id).toBe("")
  })

  it("parses retry field", async () => {
    const raw = "retry: 5000\ndata: test\n\n"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events[0].retry).toBe(5000)
  })

  it("ignores non-numeric retry", async () => {
    const raw = "retry: abc\ndata: test\n\n"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events[0].retry).toBeUndefined()
  })

  it("handles cross-chunk event (event split across TCP chunks)", async () => {
    const raw = "event: chunk\ndata: {\"delta\":\"hello world\"}\n\n"
    // Split into 5-byte chunks to fragment the event
    const events = await collect(parseSSEBytes(toChunkedStream(raw, 5)))
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe("chunk")
    expect(events[0].data).toBe('{"delta":"hello world"}')
  })

  it("handles event split mid-field name", async () => {
    const raw = "event: done\ndata: {\"finish_reason\":\"stop\"}\n\n"
    // Split at 3-byte boundaries — will fragment "event" and "data" keywords
    const events = await collect(parseSSEBytes(toChunkedStream(raw, 3)))
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe("done")
  })

  it("strips single leading space from value", async () => {
    const raw = "data: hello\n\n"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events[0].data).toBe("hello")
  })

  it("preserves value without leading space", async () => {
    const raw = "data:hello\n\n"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events[0].data).toBe("hello")
  })

  it("handles field with no value (no colon)", async () => {
    const raw = "data\n\n"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events[0].data).toBe("")
  })

  it("emits final event when stream ends without trailing newline", async () => {
    const raw = "data: final"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe("final")
  })

  it("ignores empty events (double newline with no data)", async () => {
    const raw = "\n\ndata: real\n\n"
    const events = await collect(parseSSEBytes(toStream(raw)))
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe("real")
  })
})

// --- parseChunk tests ---

describe("parseChunk", () => {
  it("maps chunk event to StreamChunk", () => {
    const event: SSEEvent = { eventType: "chunk", data: '{"delta":"hi","tool_calls":null}', id: "", retry: undefined }
    const chunk = parseChunk(event)
    expect(chunk).toEqual({ event: "chunk", data: { delta: "hi", tool_calls: null } })
  })

  it("maps tool_call event", () => {
    const event: SSEEvent = {
      eventType: "tool_call",
      data: '{"index":0,"id":"call_1","function":{"name":"foo","arguments":""}}',
      id: "", retry: undefined,
    }
    const chunk = parseChunk(event)
    expect(chunk!.event).toBe("tool_call")
    expect((chunk!.data as any).index).toBe(0)
    expect((chunk!.data as any).id).toBe("call_1")
  })

  it("maps usage event", () => {
    const event: SSEEvent = {
      eventType: "usage",
      data: '{"prompt_tokens":10,"completion_tokens":5,"reasoning_tokens":0}',
      id: "", retry: undefined,
    }
    const chunk = parseChunk(event)
    expect(chunk!.event).toBe("usage")
    expect((chunk!.data as any).prompt_tokens).toBe(10)
  })

  it("maps done event", () => {
    const event: SSEEvent = {
      eventType: "done",
      data: '{"finish_reason":"stop"}',
      id: "", retry: undefined,
    }
    const chunk = parseChunk(event)
    expect(chunk).toEqual({ event: "done", data: { finish_reason: "stop" } })
  })

  it("maps error event", () => {
    const event: SSEEvent = {
      eventType: "error",
      data: '{"code":"PROVIDER_500","message":"Internal server error"}',
      id: "", retry: undefined,
    }
    const chunk = parseChunk(event)
    expect(chunk!.event).toBe("error")
    expect((chunk!.data as any).code).toBe("PROVIDER_500")
  })

  it("maps default 'message' event type to 'chunk'", () => {
    const event: SSEEvent = { eventType: "message", data: '{"delta":"x","tool_calls":null}', id: "", retry: undefined }
    const chunk = parseChunk(event)
    expect(chunk!.event).toBe("chunk")
  })

  it("returns null for unknown event types", () => {
    const event: SSEEvent = { eventType: "heartbeat", data: '{}', id: "", retry: undefined }
    const chunk = parseChunk(event)
    expect(chunk).toBeNull()
  })

  it("returns error chunk for invalid JSON", () => {
    const event: SSEEvent = { eventType: "chunk", data: "not json", id: "", retry: undefined }
    const chunk = parseChunk(event)
    expect(chunk!.event).toBe("error")
    expect((chunk!.data as any).code).toBe("SSE_PARSE_ERROR")
  })
})

// --- Golden fixture replay tests ---

describe("parseSSE golden fixtures", () => {
  it("parses text-completion.txt correctly", async () => {
    const raw = loadFixture("text-completion.txt")
    const chunks = await collect(parseSSE(toStream(raw)))

    // 3 chunk events + 1 usage + 1 done = 5
    expect(chunks).toHaveLength(5)
    expect(chunks[0]).toEqual({ event: "chunk", data: { delta: "Hello", tool_calls: null } })
    expect(chunks[1]).toEqual({ event: "chunk", data: { delta: " world", tool_calls: null } })
    expect(chunks[2]).toEqual({ event: "chunk", data: { delta: "!", tool_calls: null } })
    expect(chunks[3].event).toBe("usage")
    expect((chunks[3].data as any).prompt_tokens).toBe(10)
    expect(chunks[4]).toEqual({ event: "done", data: { finish_reason: "stop" } })
  })

  it("parses tool-call-single.txt correctly", async () => {
    const raw = loadFixture("tool-call-single.txt")
    const chunks = await collect(parseSSE(toStream(raw)))

    // 5 tool_call chunks + 1 usage + 1 done = 7
    expect(chunks).toHaveLength(7)
    expect(chunks[0].event).toBe("tool_call")
    expect((chunks[0].data as any).id).toBe("call_abc123")
    expect((chunks[0].data as any).function.name).toBe("get_weather")

    // Subsequent chunks have arguments fragments
    expect((chunks[1].data as any).function.arguments).toBe('{"lo')
    expect((chunks[2].data as any).function.arguments).toBe("cation")
    expect((chunks[3].data as any).function.arguments).toBe('": "San')
    expect((chunks[4].data as any).function.arguments).toBe(' Francisco"}')

    expect(chunks[5].event).toBe("usage")
    expect(chunks[6]).toEqual({ event: "done", data: { finish_reason: "tool_calls" } })
  })

  it("parses tool-call-multi.txt correctly", async () => {
    const raw = loadFixture("tool-call-multi.txt")
    const chunks = await collect(parseSSE(toStream(raw)))

    // 4 tool_call chunks + 1 usage + 1 done = 6
    expect(chunks).toHaveLength(6)
    expect((chunks[0].data as any).index).toBe(0)
    expect((chunks[0].data as any).function.name).toBe("get_weather")
    expect((chunks[2].data as any).index).toBe(1)
    expect((chunks[2].data as any).function.name).toBe("get_time")
    expect(chunks[5]).toEqual({ event: "done", data: { finish_reason: "tool_calls" } })
  })

  it("parses error-mid-stream.txt correctly", async () => {
    const raw = loadFixture("error-mid-stream.txt")
    const chunks = await collect(parseSSE(toStream(raw)))

    expect(chunks).toHaveLength(2)
    expect(chunks[0].event).toBe("chunk")
    expect(chunks[1].event).toBe("error")
    expect((chunks[1].data as any).code).toBe("STREAM_INTERRUPTED")
  })

  it("parses mixed-content-and-tools.txt correctly", async () => {
    const raw = loadFixture("mixed-content-and-tools.txt")
    const chunks = await collect(parseSSE(toStream(raw)))

    // 2 chunks + 2 tool_call + 1 usage + 1 done = 6
    expect(chunks).toHaveLength(6)
    expect(chunks[0]).toEqual({ event: "chunk", data: { delta: "Let me check ", tool_calls: null } })
    expect(chunks[1]).toEqual({ event: "chunk", data: { delta: "the weather.", tool_calls: null } })
    expect(chunks[2].event).toBe("tool_call")
    expect(chunks[5]).toEqual({ event: "done", data: { finish_reason: "tool_calls" } })
  })

  it("handles golden fixtures with TCP fragmentation", async () => {
    // Replay text-completion.txt with 7-byte chunks (prime number to maximize edge cases)
    const raw = loadFixture("text-completion.txt")
    const chunks = await collect(parseSSE(toChunkedStream(raw, 7)))

    expect(chunks).toHaveLength(5)
    expect(chunks[0]).toEqual({ event: "chunk", data: { delta: "Hello", tool_calls: null } })
    expect(chunks[4]).toEqual({ event: "done", data: { finish_reason: "stop" } })
  })
})

// --- isStreamingPort type guard test ---

describe("isStreamingPort", () => {
  it("returns false for ModelPortBase", async () => {
    const { isStreamingPort } = await import("../../src/hounfour/types.js")
    const port = {
      complete: async () => ({} as any),
      capabilities: () => ({} as any),
      healthCheck: async () => ({} as any),
    }
    expect(isStreamingPort(port)).toBe(false)
  })

  it("returns true for ModelPortStreaming", async () => {
    const { isStreamingPort } = await import("../../src/hounfour/types.js")
    const port = {
      complete: async () => ({} as any),
      capabilities: () => ({} as any),
      healthCheck: async () => ({} as any),
      stream: async function* () {},
    }
    expect(isStreamingPort(port)).toBe(true)
  })
})
