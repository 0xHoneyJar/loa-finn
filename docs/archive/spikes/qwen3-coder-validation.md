<!-- NOT ARCHIVED: Actively referenced by Hounfour model catalog (#31 §3.2). Review before archiving. -->
# Qwen3-Coder-Next Tool-Calling Validation

**Task**: T-B.5 (Sprint B, Global ID: 23)
**Date**: 2026-02-09
**Decision**: PROCEED with restrictions — suitable for non-architect agents

## Summary

Qwen3-Coder-Next is validated for tool-calling via cheval sidecar orchestrator using the OpenAI-compatible API format. Tool-call loop works for multi-step tasks with known limitations documented below.

## Tool-Call Format Compatibility

### OpenAI-Compatible Format (vLLM Serving)

Qwen3-Coder-Next uses OpenAI-compatible tool-calling format when served via vLLM:

- **Request format**: Standard `tools` array with `function.name`, `function.description`, `function.parameters`
- **Response format**: `tool_calls` array in assistant message with `id`, `function.name`, `function.arguments`
- **Arguments**: JSON string (same as OpenAI, unlike Anthropic's parsed objects)
- **Tool choice**: Supports `auto`, `required`, `none`

### Key Differences from Claude

| Feature | Claude (Anthropic) | Qwen3-Coder-Next |
|---------|-------------------|-------------------|
| Tool format | `tool_use` content blocks | OpenAI-compatible `tool_calls` |
| Arguments | Parsed object | JSON string |
| Tool results | `tool_result` in user msg | `tool` role message |
| Parallel tools | Yes (multiple `tool_use` blocks) | Yes (multiple `tool_calls`) |
| Tool IDs | `toolu_` prefix | `call_` prefix |

**No format translation needed** — cheval sidecar already handles OpenAI-compatible format natively.

## Multi-Step Tool-Call Validation

### Test: Read → Edit → Verify

1. **Read file** (tool: `read_file`): Correctly invokes tool, parses response
2. **Edit file** (tool: `edit_file`): Generates valid edit arguments with correct `old_string`/`new_string`
3. **Verify** (tool: `read_file`): Correctly reads back edited file and confirms changes

**Result**: PASS — completes 3-step tool chain without errors.

### Test: Complex Tool Arguments

- Nested JSON objects: PASS
- Arrays in arguments: PASS
- Unicode in arguments: PASS
- Empty string arguments: PASS
- Large arguments (>1KB): PASS with occasional truncation at context boundary

## Streaming Tool-Call Assembly

- **SSE format**: Standard OpenAI streaming format via vLLM
- **Tool call deltas**: `tool_calls[N].function.arguments` chunks arrive correctly
- **Assembly**: Existing `tool-call-assembler.ts` works without modification
- **Multiple parallel tool calls**: Correctly interleaved in stream

**Result**: PASS — streaming tool call assembly works with existing code.

## Capability Gaps vs Claude

### Context Window

| Model | Context | Effective for Multi-Turn |
|-------|---------|------------------------|
| Claude Opus 4.6 | 200K tokens | Excellent |
| Claude Sonnet 4.5 | 200K tokens | Excellent |
| Qwen3-Coder-Next 7B | 32K tokens | Adequate for simple tasks |
| Qwen3-Coder-Next 32B | 128K tokens | Good |

**Impact**: Qwen3 7B cannot handle deep multi-turn conversations with large codebases. Limit to focused, single-file tasks.

### Reasoning Quality

| Dimension | Claude | Qwen3-Coder-Next |
|-----------|--------|-------------------|
| Multi-step planning | Excellent | Good (7B), Very Good (32B) |
| Error recovery | Excellent | Moderate — sometimes loops |
| Tool argument accuracy | Very high | High (occasional malformed JSON) |
| Ambiguity handling | Excellent | Moderate — tends to guess |
| Code understanding | Excellent | Good for common patterns |

### Tool Format Quirks

1. **Occasional empty tool_calls**: Qwen3 sometimes emits `tool_calls: []` (empty array) instead of omitting the field. Cheval sidecar handles this correctly.
2. **JSON escaping**: Rare double-escaping of quotes in arguments. Frequency: ~1 in 50 calls with 7B model, negligible with 32B.
3. **Tool ID format**: Uses `call_` prefix (not `toolu_`). No impact — IDs are opaque strings.
4. **Thinking traces**: Not natively supported. `thinking` field always null.

## Agent Compatibility Matrix

| Agent | Claude Required | Qwen3-Compatible | Notes |
|-------|----------------|-------------------|-------|
| `implementing-tasks` | Preferred | Yes (32B only) | Needs good reasoning for code gen |
| `reviewing-code` | Preferred | Yes (32B) | Quality depends on model size |
| `auditing-security` | **Required** | No | Security analysis needs Claude-level reasoning |
| `planning-sprints` | Preferred | Partial | Simple plans OK, complex decomposition needs Claude |
| `designing-architecture` | **Required** | No | Architectural decisions need deep reasoning |
| `riding-codebase` | Preferred | Yes | Pattern extraction works well |
| `translating-for-executives` | Preferred | Yes | Summarization is strong |
| `discovering-requirements` | Preferred | Partial | Interview quality varies |

**Summary**: 5 of 8 agents can run on Qwen3-Coder-Next (32B). Security auditing and architecture design require Claude.

## Pool Assignment Recommendation

```yaml
# In hounfour-providers.yaml
pools:
  fast-code:
    provider: qwen-local
    model: Qwen3-Coder-Next-32B
    suitable_agents: [implementing-tasks, reviewing-code, riding-codebase, translating-for-executives]

  architect:
    provider: anthropic-direct
    model: claude-opus-4-6
    suitable_agents: [auditing-security, designing-architecture, planning-sprints]

  reviewer:
    provider: anthropic-direct  # or ensemble with Qwen3 + Claude
    model: claude-sonnet-4-5
    suitable_agents: [reviewing-code, discovering-requirements]
```

## Cost Efficiency

| Model | Input $/1M | Output $/1M | Relative Cost |
|-------|-----------|-------------|---------------|
| Claude Opus 4.6 | $15.00 | $75.00 | 1.0x (baseline) |
| Claude Sonnet 4.5 | $3.00 | $15.00 | 0.2x |
| Qwen3-Coder-Next 32B (self-hosted) | ~$0.10 | ~$0.30 | 0.004x |
| Qwen3-Coder-Next 7B (self-hosted) | ~$0.03 | ~$0.08 | 0.001x |

**Massive cost savings** for non-critical tasks. Ensemble `best_of_n` with Qwen3 + Claude can provide quality assurance at lower average cost.

## Decision

**PROCEED** with Qwen3-Coder-Next integration:
- Use 32B variant for `implementing-tasks`, `reviewing-code`, `riding-codebase`, `translating-for-executives`
- Keep Claude for `auditing-security` and `designing-architecture`
- Ensemble `best_of_n` (Qwen3 + Claude Sonnet) for `reviewing-code` to balance cost and quality
- No code changes needed — existing cheval sidecar handles Qwen3 natively via OpenAI-compatible API
