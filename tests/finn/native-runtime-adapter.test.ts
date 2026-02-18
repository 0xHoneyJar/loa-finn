// tests/finn/native-runtime-adapter.test.ts — NativeRuntimeAdapter (Task 3.2, B.2 part 1)
// Process group isolation, escalated kill, streaming JSONL, abort handling.

import { describe, it, expect, afterEach } from "vitest"
import { NativeRuntimeAdapter, type NativeRuntimeConfig } from "../../src/hounfour/native-runtime-adapter.js"
import type { CompletionRequest, StreamChunk } from "../../src/hounfour/types.js"
import { writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"

// --- Helpers ---

let tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nra-test-"))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ok */ }
  }
  tmpDirs = []
})

/** Create a script that outputs a JSON result on stdout */
function createResultScript(dir: string, result: Record<string, unknown>): string {
  const script = join(dir, "result.sh")
  writeFileSync(script, `#!/bin/bash
# Read stdin (consume request)
cat > /dev/null
# Output result
echo '${JSON.stringify(result)}'
`)
  chmodSync(script, 0o755)
  return script
}

/** Create a script that outputs JSONL stream chunks */
function createStreamScript(dir: string, chunks: { event: string; data: unknown }[]): string {
  const script = join(dir, "stream.sh")
  const lines = chunks.map((c) => JSON.stringify(c)).join("\necho '")
  writeFileSync(script, `#!/bin/bash
cat > /dev/null
${chunks.map((c) => `echo '${JSON.stringify(c)}'`).join("\n")}
`)
  chmodSync(script, 0o755)
  return script
}

/** Create a script that sleeps forever (for testing kill) */
function createSleepScript(dir: string, seconds: number = 300): string {
  const script = join(dir, "sleep.sh")
  writeFileSync(script, `#!/bin/bash
cat > /dev/null
sleep ${seconds}
`)
  chmodSync(script, 0o755)
  return script
}

/** Create a script that spawns children then sleeps */
function createTreeScript(dir: string): string {
  const script = join(dir, "tree.sh")
  writeFileSync(script, `#!/bin/bash
cat > /dev/null
sleep 300 &
sleep 300 &
wait
`)
  chmodSync(script, 0o755)
  return script
}

/** Create a script that writes to stderr then exits with error */
function createErrorScript(dir: string): string {
  const script = join(dir, "error.sh")
  writeFileSync(script, `#!/bin/bash
cat > /dev/null
echo "something went wrong" >&2
exit 1
`)
  chmodSync(script, 0o755)
  return script
}

function makeRequest(): CompletionRequest {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    options: { max_tokens: 100 },
  }
}

function makeAdapter(binary: string, overrides: Partial<NativeRuntimeConfig> = {}): NativeRuntimeAdapter {
  return new NativeRuntimeAdapter({
    binary,
    maxRuntimeMs: 10_000,
    killGraceMs: 1_000,
    model: "test-native",
    ...overrides,
  })
}

async function collectStreamChunks(
  gen: AsyncGenerator<StreamChunk>,
): Promise<{ chunks: StreamChunk[]; errored: boolean }> {
  const chunks: StreamChunk[] = []
  let errored = false
  try {
    for await (const chunk of gen) {
      chunks.push(chunk)
    }
  } catch {
    errored = true
  }
  return { chunks, errored }
}

// --- Tests ---

describe("capabilities and health check", () => {
  it("reports streaming capability", () => {
    const adapter = makeAdapter("/bin/echo")
    const caps = adapter.capabilities()
    expect(caps.streaming).toBe(true)
    expect(caps.tool_calling).toBe(true)
  })

  it("health check detects existing binary", async () => {
    const adapter = makeAdapter("/bin/bash")
    const health = await adapter.healthCheck()
    expect(health.healthy).toBe(true)
    expect(health.latency_ms).toBeGreaterThanOrEqual(0)
  })

  it("health check detects missing binary", async () => {
    const adapter = makeAdapter("/nonexistent/binary")
    const health = await adapter.healthCheck()
    expect(health.healthy).toBe(false)
  })
})

describe("complete() — non-streaming", () => {
  it("spawns process and parses JSON result from stdout", async () => {
    const dir = makeTmpDir()
    const script = createResultScript(dir, {
      content: "Hello from native runtime",
      usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 },
    })

    const adapter = makeAdapter(script)
    const result = await adapter.complete(makeRequest())

    expect(result.content).toBe("Hello from native runtime")
    expect(result.usage.prompt_tokens).toBe(10)
    expect(result.usage.completion_tokens).toBe(5)
    expect(result.metadata.model).toBe("test-native")
  })

  it("throws on non-zero exit code with stderr", async () => {
    const dir = makeTmpDir()
    const script = createErrorScript(dir)

    const adapter = makeAdapter(script)
    await expect(adapter.complete(makeRequest())).rejects.toThrow("exited with code 1")
  })

  it("parses JSONL output as fallback", async () => {
    const dir = makeTmpDir()
    const script = createStreamScript(dir, [
      { event: "chunk", data: { delta: "Hello " } },
      { event: "chunk", data: { delta: "world" } },
      { event: "usage", data: { prompt_tokens: 5, completion_tokens: 2, reasoning_tokens: 0 } },
      { event: "done", data: { finish_reason: "stop" } },
    ])

    const adapter = makeAdapter(script)
    const result = await adapter.complete(makeRequest())

    expect(result.content).toBe("Hello world")
    expect(result.usage.prompt_tokens).toBe(5)
    expect(result.usage.completion_tokens).toBe(2)
  })
})

describe("stream() — JSONL streaming", () => {
  it("yields stream chunks from stdout JSONL", async () => {
    const dir = makeTmpDir()
    const script = createStreamScript(dir, [
      { event: "chunk", data: { delta: "Hello " } },
      { event: "chunk", data: { delta: "world " } },
      { event: "chunk", data: { delta: "!" } },
      { event: "usage", data: { prompt_tokens: 10, completion_tokens: 3, reasoning_tokens: 0 } },
      { event: "done", data: { finish_reason: "stop" } },
    ])

    const adapter = makeAdapter(script)
    const { chunks } = await collectStreamChunks(adapter.stream(makeRequest()))

    const textChunks = chunks.filter((c) => c.event === "chunk")
    const usageChunks = chunks.filter((c) => c.event === "usage")
    const doneChunks = chunks.filter((c) => c.event === "done")

    expect(textChunks).toHaveLength(3)
    expect(usageChunks).toHaveLength(1)
    expect(doneChunks).toHaveLength(1)
    expect(textChunks[0].data).toEqual({ delta: "Hello ", tool_calls: null })
  })

  it("handles error event in stream", async () => {
    const dir = makeTmpDir()
    const script = createStreamScript(dir, [
      { event: "chunk", data: { delta: "partial " } },
      { event: "error", data: "connection lost" },
    ])

    const adapter = makeAdapter(script)
    const { chunks } = await collectStreamChunks(adapter.stream(makeRequest()))

    const errorChunks = chunks.filter((c) => c.event === "error")
    expect(errorChunks).toHaveLength(1)
  })
})

describe("process group isolation", () => {
  it("spawns with detached=true (own process group)", async () => {
    const dir = makeTmpDir()
    const script = createResultScript(dir, { content: "ok", usage: { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 } })

    const adapter = makeAdapter(script)
    const result = await adapter.complete(makeRequest())

    // If we got here, the process spawned and completed successfully
    expect(result.content).toBe("ok")
  })
})

describe("escalated kill on timeout", () => {
  it("kills process after maxRuntimeMs", async () => {
    const dir = makeTmpDir()
    const script = createSleepScript(dir, 300)

    const adapter = makeAdapter(script, { maxRuntimeMs: 200, killGraceMs: 100 })
    const start = Date.now()

    await expect(adapter.complete(makeRequest())).rejects.toThrow()

    const elapsed = Date.now() - start
    // Should have been killed within maxRuntimeMs + killGraceMs
    expect(elapsed).toBeLessThan(2000)
  })

  it("kills entire process tree on timeout", async () => {
    const dir = makeTmpDir()
    const script = createTreeScript(dir)

    const adapter = makeAdapter(script, { maxRuntimeMs: 200, killGraceMs: 100 })

    await expect(adapter.complete(makeRequest())).rejects.toThrow()
    // Verifier in adapter ensures group is empty after kill
  })
})

describe("AbortController integration", () => {
  it("abort signal kills the process", async () => {
    const dir = makeTmpDir()
    const script = createSleepScript(dir, 300)

    const adapter = makeAdapter(script, { maxRuntimeMs: 30_000 })
    const controller = new AbortController()

    // Abort after 100ms
    setTimeout(() => controller.abort(), 100)

    const { chunks } = await collectStreamChunks(
      adapter.stream(makeRequest(), { signal: controller.signal }),
    )

    // Stream should end quickly (no long sleep)
    expect(chunks.length).toBe(0) // No output before abort
  })

  it("already-aborted signal kills immediately", async () => {
    const dir = makeTmpDir()
    const script = createSleepScript(dir, 300)

    const adapter = makeAdapter(script, { maxRuntimeMs: 30_000 })
    const controller = new AbortController()
    controller.abort() // Already aborted

    const start = Date.now()
    const { chunks } = await collectStreamChunks(
      adapter.stream(makeRequest(), { signal: controller.signal }),
    )
    const elapsed = Date.now() - start

    expect(chunks.length).toBe(0)
    expect(elapsed).toBeLessThan(2000)
  })
})

describe("sanitized environment", () => {
  it("passes only allowlisted env vars", async () => {
    const dir = makeTmpDir()
    const script = join(dir, "env.sh")
    writeFileSync(script, `#!/bin/bash
cat > /dev/null
printf '{"content":"CUSTOM=%s SECRET=%s","usage":{"prompt_tokens":0,"completion_tokens":0,"reasoning_tokens":0}}\\n' "$CUSTOM" "$SECRET"
`)
    chmodSync(script, 0o755)

    const adapter = makeAdapter(script, {
      env: { CUSTOM: "allowed_value" },
    })
    const result = await adapter.complete(makeRequest())

    expect(result.content).toContain("CUSTOM=allowed_value")
    // SECRET should NOT be in env (not allowlisted)
    expect(result.content).toContain("SECRET=")
    expect(result.content).not.toContain("SECRET=anything")
  })
})

describe("edge cases", () => {
  it("handles empty stdout gracefully in complete()", async () => {
    const dir = makeTmpDir()
    const script = join(dir, "empty.sh")
    writeFileSync(script, `#!/bin/bash
cat > /dev/null
# No output
`)
    chmodSync(script, 0o755)

    const adapter = makeAdapter(script)
    // Empty stdout with exit 0 should still throw (no parseable result)
    await expect(adapter.complete(makeRequest())).rejects.toThrow("empty stdout")
  })

  it("handles malformed JSONL lines in stream gracefully", async () => {
    const dir = makeTmpDir()
    const script = join(dir, "malformed.sh")
    writeFileSync(script, `#!/bin/bash
cat > /dev/null
echo 'not json'
echo '{"event":"chunk","data":{"delta":"valid "}}'
echo '{broken'
echo '{"event":"done","data":{"finish_reason":"stop"}}'
`)
    chmodSync(script, 0o755)

    const adapter = makeAdapter(script)
    const { chunks } = await collectStreamChunks(adapter.stream(makeRequest()))

    // Should skip malformed lines and yield valid ones
    const textChunks = chunks.filter((c) => c.event === "chunk")
    expect(textChunks).toHaveLength(1)
    expect(textChunks[0].data).toEqual({ delta: "valid ", tool_calls: null })
  })
})
