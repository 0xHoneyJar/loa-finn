# Anthropic Messages API Spike Report

> **Archived**: Incorporated into Hounfour Phase 0 (cycle-013).
> No active decisions.

**Task**: T-B.1 (Sprint B, Global ID: 23)
**Date**: 2026-02-09
**Decision**: PROCEED with Messages API adapter

## Summary

The Anthropic Messages API is fully compatible with loa-finn's ModelPort interface. All requirements for AnthropicAdapter are met by the Messages API v1.

## API Compatibility Assessment

### Authentication
- API key via `x-api-key` header (not Bearer auth)
- Also accepts `anthropic-version` header (required, currently `2023-06-01`)
- Key available from `ANTHROPIC_API_KEY` env var

### Streaming (SSE)
- `stream: true` in request body enables SSE streaming
- Events: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
- Maps cleanly to our StreamChunk types:
  - `content_block_delta` (type: `text_delta`) → `{ event: "chunk", data: { delta, tool_calls: null } }`
  - `content_block_delta` (type: `input_json_delta`) → `{ event: "tool_call", data: { index, function: { arguments } } }`
  - `content_block_start` (type: `tool_use`) → `{ event: "tool_call", data: { index, id, function: { name } } }`
  - `message_delta` → `{ event: "done", data: { finish_reason } }` (maps `stop_reason` to `finish_reason`)
  - `message_start` → usage.input_tokens available
  - `message_delta` → usage.output_tokens available
- Abort: closing the connection (AbortController) terminates the request server-side

### Tool Use
- Request format: `tools` array with `name`, `description`, `input_schema` (JSON Schema)
- Response: content blocks of type `tool_use` with `id`, `name`, `input` (parsed object, not string)
- Tool results: `tool_result` content blocks in user message with `tool_use_id`
- Key difference from OpenAI: tool arguments come as parsed object (not JSON string)

### Thinking/Extended Thinking
- `thinking` parameter: `{ type: "enabled", budget_tokens: N }`
- Thinking content blocks: type `thinking` with `thinking` text
- Maps to `CompletionResult.thinking` field (non-null for thinking models)
- Thinking tokens reported in `usage` as part of output_tokens (no separate field in API)
- For reasoning token accounting: compute `reasoning_tokens = thinking_block_lengths` (approximate)

### Token Usage
- Available in response `usage` field: `{ input_tokens, output_tokens }`
- Streaming: `input_tokens` in `message_start`, `output_tokens` in `message_delta`
- Cache creation/read tokens also available (not needed for loa-finn)

### Model Mapping
- `claude-opus-4-6` → Opus 4.6 (enterprise pool "architect")
- `claude-sonnet-4-5-20250929` → Sonnet 4.5 (enterprise pool, future)
- Max output tokens: varies by model, specified via `max_tokens` (required parameter)

## Message Format Mapping

### loa-finn → Anthropic

| CanonicalMessage | Anthropic Format |
|-----------------|-----------------|
| `{ role: "system", content }` | `system` parameter (top-level, not in messages) |
| `{ role: "user", content }` | `{ role: "user", content: [{ type: "text", text }] }` |
| `{ role: "assistant", content }` | `{ role: "assistant", content: [{ type: "text", text }] }` |
| `{ role: "assistant", tool_calls }` | `{ role: "assistant", content: [{ type: "tool_use", id, name, input }] }` |
| `{ role: "tool", content, tool_call_id }` | `{ role: "user", content: [{ type: "tool_result", tool_use_id, content }] }` |

Key differences:
1. System message is top-level parameter, not in messages array
2. Tool results are `user` role messages with `tool_result` content blocks
3. Tool arguments are objects (not JSON strings) — need `JSON.parse()` on our side
4. Content is always an array of content blocks (not plain string)

### Tool Definition Mapping

| loa-finn ToolDefinition | Anthropic Tool |
|------------------------|---------------|
| `function.name` | `name` |
| `function.description` | `description` |
| `function.parameters` | `input_schema` |

## Latency Characteristics

- TTFB (time to first byte): ~500-1500ms for Sonnet, ~1000-3000ms for Opus
- Streaming chunk interval: ~20-50ms
- Tool use adds one round-trip per tool call
- Thinking mode: additional 2-10s latency depending on budget_tokens

## Edge Cases

1. **Empty content**: Anthropic rejects empty content strings — must omit or use `[{ type: "text", text: " " }]`
2. **Max tokens required**: Unlike OpenAI, `max_tokens` is required (not optional)
3. **Stop reason mapping**: `end_turn` → `stop`, `tool_use` → `tool_calls`, `max_tokens` → `length`
4. **Rate limits**: 429 with `retry-after` header, exponential backoff recommended
5. **Overloaded**: 529 status (Anthropic-specific) — treat as retryable like 503

## Decision

**PROCEED** with AnthropicAdapter implementation (T-B.2). The Messages API maps cleanly to our ModelPort interface with the message format translation described above.
