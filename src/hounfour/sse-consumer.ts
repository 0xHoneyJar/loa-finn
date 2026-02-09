// src/hounfour/sse-consumer.ts — W3C-compliant SSE consumer (SDD §4.4, T-2.1)
//
// Parses Server-Sent Events from an AsyncIterable<Uint8Array> (undici response.body)
// and maps them to typed StreamChunk objects per the wire contract.

import type {
  StreamChunk,
  StreamChunkData,
  StreamToolCallData,
  StreamUsageData,
  StreamDoneData,
  StreamErrorData,
  StreamEventType,
} from "./types.js"

// --- SSE Event (raw, before mapping to StreamChunk) ---

export interface SSEEvent {
  eventType: string   // "message" if no event: field
  data: string
  id: string
  retry: number | undefined
}

// --- SSE Parser ---

/**
 * W3C-compliant SSE decoder for async byte streams.
 *
 * Handles: CRLF normalization, multi-line data, cross-chunk state,
 * comments, id/retry fields. Events dispatched on empty lines.
 *
 * Mirrors the Python sse_decoder.py implementation for interop.
 */
export async function* parseSSEBytes(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder("utf-8")
  let buffer = ""
  let eventType = "message"
  let dataLines: string[] = []
  let eventId = ""
  let retry: number | undefined

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })

    // Normalize all line endings to LF
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

    while (buffer.includes("\n")) {
      const idx = buffer.indexOf("\n")
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)

      if (line === "") {
        // Empty line = dispatch event (if we have data)
        if (dataLines.length > 0) {
          yield {
            eventType,
            data: dataLines.join("\n"),
            id: eventId,
            retry,
          }
        }
        // Reset per-event fields
        eventType = "message"
        dataLines = []
        continue
      }

      if (line.startsWith(":")) {
        // Comment — ignore
        continue
      }

      // Parse field:value
      let fieldName: string
      let value: string
      const colonIdx = line.indexOf(":")
      if (colonIdx !== -1) {
        fieldName = line.slice(0, colonIdx)
        value = line.slice(colonIdx + 1)
        if (value.startsWith(" ")) {
          value = value.slice(1) // Strip single leading space
        }
      } else {
        fieldName = line
        value = ""
      }

      if (fieldName === "event") {
        eventType = value
      } else if (fieldName === "data") {
        dataLines.push(value)
      } else if (fieldName === "id") {
        if (!value.includes("\0")) {
          eventId = value
        }
      } else if (fieldName === "retry") {
        const parsed = parseInt(value, 10)
        if (!isNaN(parsed)) {
          retry = parsed
        }
      }
      // Unknown fields are ignored per spec
    }
  }

  // Flush remaining decoder bytes
  buffer += decoder.decode(new Uint8Array(), { stream: false })

  // Process any remaining content
  if (buffer) {
    const line = buffer
    if (!line.startsWith(":")) {
      const colonIdx = line.indexOf(":")
      let fieldName: string
      let value: string
      if (colonIdx !== -1) {
        fieldName = line.slice(0, colonIdx)
        value = line.slice(colonIdx + 1)
        if (value.startsWith(" ")) value = value.slice(1)
      } else {
        fieldName = line
        value = ""
      }
      if (fieldName === "event") eventType = value
      else if (fieldName === "data") dataLines.push(value)
      else if (fieldName === "id" && !value.includes("\0")) eventId = value
      else if (fieldName === "retry") {
        const parsed = parseInt(value, 10)
        if (!isNaN(parsed)) retry = parsed
      }
    }
  }

  // Emit final event if we have accumulated data
  if (dataLines.length > 0) {
    yield {
      eventType,
      data: dataLines.join("\n"),
      id: eventId,
      retry,
    }
  }
}

// --- Wire Contract Event Names ---

const KNOWN_EVENTS = new Set<StreamEventType>(["chunk", "tool_call", "usage", "done", "error"])

/**
 * Parse an SSE event's data field as JSON and map to a typed StreamChunk.
 *
 * Wire contract:
 * - event: chunk     → { delta: string, tool_calls: null }
 * - event: tool_call → { index, id?, function: { name?, arguments } }
 * - event: usage     → { prompt_tokens, completion_tokens, reasoning_tokens }
 * - event: done      → { finish_reason }
 * - event: error     → { code, message }
 * - Unknown events are logged and skipped (returns null)
 * - Invalid JSON yields an error StreamChunk
 */
export function parseChunk(event: SSEEvent): StreamChunk | null {
  const eventName = event.eventType === "message" ? "chunk" : event.eventType

  // Skip unknown event types
  if (!KNOWN_EVENTS.has(eventName as StreamEventType)) {
    return null
  }

  // Parse JSON data
  let data: unknown
  try {
    data = JSON.parse(event.data)
  } catch {
    return {
      event: "error",
      data: {
        code: "SSE_PARSE_ERROR",
        message: `Invalid JSON in SSE ${eventName} event: ${event.data.slice(0, 200)}`,
      },
    }
  }

  // Map to typed StreamChunk based on event name
  switch (eventName) {
    case "chunk":
      return {
        event: "chunk",
        data: data as StreamChunkData,
      }
    case "tool_call":
      return {
        event: "tool_call",
        data: data as StreamToolCallData,
      }
    case "usage":
      return {
        event: "usage",
        data: data as StreamUsageData,
      }
    case "done":
      return {
        event: "done",
        data: data as StreamDoneData,
      }
    case "error":
      return {
        event: "error",
        data: data as StreamErrorData,
      }
    default:
      return null
  }
}

/**
 * High-level SSE consumer: parses bytes into typed StreamChunks.
 *
 * Composes parseSSEBytes() and parseChunk() into a single async generator.
 * Unknown events are silently skipped. Invalid JSON yields error chunks.
 */
export async function* parseSSE(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<StreamChunk> {
  for await (const event of parseSSEBytes(stream)) {
    const chunk = parseChunk(event)
    if (chunk !== null) {
      yield chunk
    }
  }
}
