// tests/finn/qwen3-coder-validation.test.ts — Qwen3-Coder-Next validation (Task 3.9, B.6)
// Validates tool-calling with qwen3_coder parser against fixture data.
// Integration test with mock vLLM endpoint.

import { describe, it, expect, afterEach } from "vitest"
import type { StreamChunk, CompletionRequest } from "../../src/hounfour/types.js"
import { NativeRuntimeAdapter } from "../../src/hounfour/native-runtime-adapter.js"
import { writeFileSync, mkdtempSync, rmSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// --- Fixtures: Qwen3-Coder tool-calling protocol ---

/** Qwen3-Coder uses a specific tool-calling format in its output */
const QWEN3_TOOL_CALL_FIXTURE = {
  /** Standard assistant response with tool call in Qwen3 format */
  singleToolCall: {
    event: "chunk",
    data: { delta: '<tool_call>\n{"name": "get_weather", "arguments": {"location": "San Francisco", "unit": "celsius"}}\n</tool_call>' },
  },
  /** Multiple tool calls in sequence */
  multiToolCall: [
    { event: "chunk", data: { delta: '<tool_call>\n{"name": "search", "arguments": {"query": "latest news"}}\n</tool_call>' } },
    { event: "chunk", data: { delta: '<tool_call>\n{"name": "summarize", "arguments": {"text": "article content"}}\n</tool_call>' } },
  ],
  /** Mixed content + tool call */
  mixedResponse: [
    { event: "chunk", data: { delta: "Let me check the weather for you.\n" } },
    { event: "chunk", data: { delta: '<tool_call>\n{"name": "get_weather", "arguments": {"location": "NYC"}}\n</tool_call>' } },
  ],
  /** Usage event from vLLM */
  usageEvent: {
    event: "usage",
    data: { prompt_tokens: 150, completion_tokens: 45, reasoning_tokens: 0 },
  },
  /** Done event */
  doneEvent: {
    event: "done",
    data: { finish_reason: "stop" },
  },
}

/** Qwen3-Coder parser configuration for vLLM */
const QWEN3_VLLM_CONFIG = {
  parser: "qwen3_coder",
  toolCallRegex: /<tool_call>\n(.*?)\n<\/tool_call>/gs,
  modelId: "Qwen/Qwen3-Coder-Next",
  vllmFlags: ["--tool-call-parser", "qwen3_coder"],
}

// --- Helpers ---

let tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qwen3-test-"))
  tmpDirs.push(dir)
  return dir
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ok */ }
  }
  tmpDirs = []
}

/** Create a mock vLLM endpoint script that outputs JSONL */
function createMockVllmScript(dir: string, events: { event: string; data: unknown }[]): string {
  const script = join(dir, "mock-vllm.sh")
  const lines = events.map((e) => `echo '${JSON.stringify(e)}'`).join("\n")
  writeFileSync(script, `#!/bin/bash\ncat > /dev/null\n${lines}\n`)
  chmodSync(script, 0o755)
  return script
}

function makeRequest(): CompletionRequest {
  return {
    messages: [
      { role: "user", content: [{ type: "text", text: "What is the weather in SF?" }] },
    ],
    options: {
      max_tokens: 500,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather for a location",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" },
                unit: { type: "string", enum: ["celsius", "fahrenheit"] },
              },
              required: ["location"],
            },
          },
        },
      ],
    },
  }
}

/** Parse Qwen3 tool calls from content string */
function parseQwen3ToolCalls(content: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = []
  const regex = /<tool_call>\n(.*?)\n<\/tool_call>/gs
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      calls.push(parsed)
    } catch { /* skip malformed */ }
  }
  return calls
}

// --- Tests ---

describe("Qwen3-Coder tool-calling validation", () => {
  afterEach(cleanup)

  it("parses single tool call from fixture data", () => {
    const content = (QWEN3_TOOL_CALL_FIXTURE.singleToolCall.data as { delta: string }).delta
    const calls = parseQwen3ToolCalls(content)

    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe("get_weather")
    expect(calls[0].arguments).toEqual({ location: "San Francisco", unit: "celsius" })
  })

  it("parses multiple tool calls from fixture data", () => {
    const content = QWEN3_TOOL_CALL_FIXTURE.multiToolCall
      .map((c) => (c.data as { delta: string }).delta)
      .join("")
    const calls = parseQwen3ToolCalls(content)

    expect(calls).toHaveLength(2)
    expect(calls[0].name).toBe("search")
    expect(calls[1].name).toBe("summarize")
  })

  it("parses mixed content + tool call", () => {
    const content = QWEN3_TOOL_CALL_FIXTURE.mixedResponse
      .map((c) => (c.data as { delta: string }).delta)
      .join("")
    const calls = parseQwen3ToolCalls(content)

    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe("get_weather")
    expect(content).toContain("Let me check the weather")
  })
})

describe("Qwen3-Coder parser configuration", () => {
  it("defines correct parser name", () => {
    expect(QWEN3_VLLM_CONFIG.parser).toBe("qwen3_coder")
  })

  it("vLLM flags include tool-call-parser", () => {
    expect(QWEN3_VLLM_CONFIG.vllmFlags).toContain("--tool-call-parser")
    expect(QWEN3_VLLM_CONFIG.vllmFlags).toContain("qwen3_coder")
  })

  it("regex matches tool_call tags", () => {
    const testContent = '<tool_call>\n{"name":"test","arguments":{}}\n</tool_call>'
    const regex = QWEN3_VLLM_CONFIG.toolCallRegex
    regex.lastIndex = 0 // Reset regex state
    const match = regex.exec(testContent)
    expect(match).not.toBeNull()
    expect(JSON.parse(match![1]).name).toBe("test")
  })
})

describe("NativeRuntimeAdapter with mock vLLM (Qwen3)", () => {
  afterEach(cleanup)

  it("streams tool-calling response from mock vLLM", async () => {
    const dir = makeTmpDir()
    const script = createMockVllmScript(dir, [
      ...QWEN3_TOOL_CALL_FIXTURE.mixedResponse,
      QWEN3_TOOL_CALL_FIXTURE.usageEvent,
      QWEN3_TOOL_CALL_FIXTURE.doneEvent,
    ])

    const adapter = new NativeRuntimeAdapter({
      binary: script,
      maxRuntimeMs: 5_000,
      killGraceMs: 500,
      model: "qwen3-coder-next",
    })

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(makeRequest())) {
      chunks.push(chunk)
    }

    const textChunks = chunks.filter(c => c.event === "chunk")
    const usageChunks = chunks.filter(c => c.event === "usage")
    const doneChunks = chunks.filter(c => c.event === "done")

    expect(textChunks.length).toBeGreaterThanOrEqual(2)
    expect(usageChunks).toHaveLength(1)
    expect(doneChunks).toHaveLength(1)

    // Verify tool call content is in the streamed chunks
    const fullContent = textChunks
      .map(c => (c.data as { delta: string }).delta)
      .join("")
    expect(fullContent).toContain("tool_call")
    expect(fullContent).toContain("get_weather")
  })

  it("complete() assembles Qwen3 tool-calling response", async () => {
    const dir = makeTmpDir()
    const script = createMockVllmScript(dir, [
      QWEN3_TOOL_CALL_FIXTURE.singleToolCall,
      QWEN3_TOOL_CALL_FIXTURE.usageEvent,
      QWEN3_TOOL_CALL_FIXTURE.doneEvent,
    ])

    const adapter = new NativeRuntimeAdapter({
      binary: script,
      maxRuntimeMs: 5_000,
      killGraceMs: 500,
      model: "qwen3-coder-next",
    })

    const result = await adapter.complete(makeRequest())

    expect(result.content).toContain("tool_call")
    const calls = parseQwen3ToolCalls(result.content)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe("get_weather")
    expect(result.usage.prompt_tokens).toBe(150)
    expect(result.metadata.model).toBe("qwen3-coder-next")
  })

  it("handles multi-tool-call response", async () => {
    const dir = makeTmpDir()
    const script = createMockVllmScript(dir, [
      ...QWEN3_TOOL_CALL_FIXTURE.multiToolCall,
      QWEN3_TOOL_CALL_FIXTURE.usageEvent,
      QWEN3_TOOL_CALL_FIXTURE.doneEvent,
    ])

    const adapter = new NativeRuntimeAdapter({
      binary: script,
      maxRuntimeMs: 5_000,
      killGraceMs: 500,
      model: "qwen3-coder-next",
    })

    const result = await adapter.complete(makeRequest())
    const calls = parseQwen3ToolCalls(result.content)

    expect(calls).toHaveLength(2)
    expect(calls[0].name).toBe("search")
    expect(calls[1].name).toBe("summarize")
  })
})
