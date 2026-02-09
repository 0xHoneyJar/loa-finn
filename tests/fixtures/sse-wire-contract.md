# SSE Wire Contract — Cheval Sidecar ↔ loa-finn

> **Version**: 1.0 (Sprint 2, Cycle 008)
> **Endpoint**: `POST /invoke/stream`

## Required Response Headers

```
Content-Type: text/event-stream
Cache-Control: no-cache
Transfer-Encoding: chunked
```

## Event Names (exhaustive)

| Event | JSON Schema | When |
|-------|-------------|------|
| `chunk` | `StreamChunkData` | Token delta |
| `tool_call` | `StreamToolCallData` | Tool call fragment |
| `usage` | `StreamUsageData` | Token usage (before done) |
| `done` | `StreamDoneData` | Stream complete |
| `error` | `StreamErrorData` | Error occurred |

Unknown event names MUST be logged and skipped (not crash).

## Termination

Stream terminates with `event: done` and `data: {}` (with `finish_reason`).
No `[DONE]` sentinel — the sidecar normalizes provider-specific terminators.

## JSON Schemas

### StreamChunkData
```json
{ "delta": "string", "tool_calls": null }
```

### StreamToolCallData
```json
{
  "index": 0,
  "id": "call_abc123",
  "function": {
    "name": "get_weather",
    "arguments": "{\"loc"
  }
}
```
- `id` and `function.name` present only on the first chunk for each tool_call index
- `function.arguments` contains incremental JSON fragments

### StreamUsageData
```json
{
  "prompt_tokens": 150,
  "completion_tokens": 42,
  "reasoning_tokens": 0
}
```

### StreamDoneData
```json
{ "finish_reason": "stop" }
```
Valid values: `"stop"`, `"tool_calls"`, `"length"`

### StreamErrorData
```json
{ "code": "PROVIDER_500", "message": "Internal server error" }
```

## Provider Normalization

The sidecar normalizes provider-specific formats:
- **OpenAI**: `data: [DONE]` → `event: done` + `data: {"finish_reason": "stop"}`
- **Tool calls**: OpenAI `choices[0].delta.tool_calls` → `event: tool_call` events
- **Usage**: OpenAI `usage` field (when present) → `event: usage`
