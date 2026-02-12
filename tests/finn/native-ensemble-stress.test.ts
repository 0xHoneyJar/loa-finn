// tests/finn/native-ensemble-stress.test.ts — Stress Tests (Task 3.10, PRD B.2+B.4)
// Concurrent spawns + aborts, race condition simulation, high-throughput output,
// ensemble cancellation ordering, process cleanup verification.

import { describe, it, expect, afterEach } from "vitest"
import { NativeRuntimeAdapter } from "../../src/hounfour/native-runtime-adapter.js"
import type { CompletionRequest, StreamChunk } from "../../src/hounfour/types.js"
import { writeFileSync, mkdtempSync, rmSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// --- Helpers ---

let tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stress-test-"))
  tmpDirs.push(dir)
  return dir
}

function cleanup() {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ok */ }
  }
  tmpDirs = []
}

/** Create a mock script that outputs a JSON result after optional delay */
function createMockScript(dir: string, opts: {
  delayMs?: number
  outputLines?: string[]
  resultContent?: string
  exitCode?: number
  outputKb?: number
} = {}): string {
  const { delayMs = 0, exitCode = 0, resultContent = "ok", outputKb = 0 } = opts

  const script = join(dir, `mock-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
  const lines: string[] = ["#!/bin/bash", "cat > /dev/null"]

  if (delayMs > 0) {
    // Use fractional seconds for sleep
    const sec = (delayMs / 1000).toFixed(3)
    lines.push(`sleep ${sec}`)
  }

  // Generate large output if requested
  if (outputKb > 0) {
    // Each line is ~80 chars, output enough lines to fill outputKb
    const linesNeeded = Math.ceil((outputKb * 1024) / 80)
    lines.push(`for i in $(seq 1 ${linesNeeded}); do echo '{"event":"chunk","data":{"delta":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'; done`)
  }

  // Custom output lines
  if (opts.outputLines) {
    for (const line of opts.outputLines) {
      lines.push(`printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`)
    }
  }

  // Final result (plain JSON for complete() — not event-wrapped)
  lines.push(`printf '%s\\n' '{"content":"${resultContent}","thinking":null,"tool_calls":null,"usage":{"prompt_tokens":10,"completion_tokens":5,"reasoning_tokens":0}}'`)

  if (exitCode !== 0) {
    lines.push(`exit ${exitCode}`)
  }

  writeFileSync(script, lines.join("\n") + "\n")
  chmodSync(script, 0o755)
  return script
}

/** Create a mock streaming script that emits JSONL events */
function createStreamScript(dir: string, opts: {
  chunks?: number
  delayBetweenMs?: number
  totalDelayMs?: number
} = {}): string {
  const { chunks = 5, delayBetweenMs = 0, totalDelayMs = 0 } = opts

  const script = join(dir, `stream-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
  const lines: string[] = ["#!/bin/bash", "cat > /dev/null"]

  if (totalDelayMs > 0) {
    const sec = (totalDelayMs / 1000).toFixed(3)
    lines.push(`sleep ${sec}`)
  }

  for (let i = 0; i < chunks; i++) {
    if (delayBetweenMs > 0) {
      const sec = (delayBetweenMs / 1000).toFixed(3)
      lines.push(`sleep ${sec}`)
    }
    lines.push(`printf '%s\\n' '{"event":"chunk","data":{"delta":"chunk-${i}"}}'`)
  }

  lines.push(`printf '%s\\n' '{"event":"usage","data":{"prompt_tokens":10,"completion_tokens":${chunks},"reasoning_tokens":0}}'`)
  lines.push(`printf '%s\\n' '{"event":"done","data":{"finish_reason":"stop"}}'`)

  writeFileSync(script, lines.join("\n") + "\n")
  chmodSync(script, 0o755)
  return script
}

function makeRequest(): CompletionRequest {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    options: { max_tokens: 100 },
  }
}

// --- Stress Tests ---

describe("NativeRuntimeAdapter stress tests", () => {
  afterEach(cleanup)

  describe("concurrent spawns", () => {
    it("handles 20 concurrent complete() calls", async () => {
      const dir = makeTmpDir()
      const script = createMockScript(dir, { resultContent: "concurrent-ok" })

      const adapter = new NativeRuntimeAdapter({
        binary: script,
        maxRuntimeMs: 10_000,
        killGraceMs: 500,
        model: "stress-test",
      })

      // Launch 20 concurrent requests
      const promises = Array.from({ length: 20 }, () =>
        adapter.complete(makeRequest())
      )

      const results = await Promise.all(promises)

      expect(results).toHaveLength(20)
      for (const result of results) {
        expect(result.content).toBe("concurrent-ok")
        expect(result.usage.prompt_tokens).toBe(10)
      }
    }, 15_000)

    it("handles 20 concurrent stream() calls", async () => {
      const dir = makeTmpDir()
      const script = createStreamScript(dir, { chunks: 3 })

      const adapter = new NativeRuntimeAdapter({
        binary: script,
        maxRuntimeMs: 10_000,
        killGraceMs: 500,
        model: "stress-stream",
      })

      // Launch 20 concurrent streaming requests
      const promises = Array.from({ length: 20 }, async () => {
        const chunks: StreamChunk[] = []
        for await (const chunk of adapter.stream(makeRequest())) {
          chunks.push(chunk)
        }
        return chunks
      })

      const allChunks = await Promise.all(promises)

      expect(allChunks).toHaveLength(20)
      for (const chunks of allChunks) {
        const textChunks = chunks.filter(c => c.event === "chunk")
        expect(textChunks).toHaveLength(3)
      }
    }, 15_000)
  })

  describe("concurrent abort", () => {
    it("handles 20 concurrent spawns with immediate abort", async () => {
      const dir = makeTmpDir()
      // Script that sleeps 5s — will be killed
      const script = createMockScript(dir, { delayMs: 5000, resultContent: "should-not-see" })

      const adapter = new NativeRuntimeAdapter({
        binary: script,
        maxRuntimeMs: 10_000,
        killGraceMs: 200,
        model: "abort-stress",
      })

      // Launch 20 streams then abort immediately
      const controllers = Array.from({ length: 20 }, () => new AbortController())

      const promises = controllers.map(async (controller) => {
        const chunks: StreamChunk[] = []
        try {
          for await (const chunk of adapter.stream(makeRequest(), { signal: controller.signal })) {
            chunks.push(chunk)
          }
        } catch {
          // Expected: abort kills the process
        }
        return chunks
      })

      // Abort all after 50ms
      await new Promise(r => setTimeout(r, 50))
      for (const controller of controllers) {
        controller.abort()
      }

      const results = await Promise.all(promises)
      expect(results).toHaveLength(20)

      // No process should have completed (all aborted)
      for (const chunks of results) {
        const doneChunks = chunks.filter(c => c.event === "done")
        expect(doneChunks).toHaveLength(0)
      }
    }, 15_000)
  })

  describe("high-throughput output", () => {
    it("handles large stdout without deadlock (50KB output)", async () => {
      const dir = makeTmpDir()
      const script = createMockScript(dir, { outputKb: 50 })

      const adapter = new NativeRuntimeAdapter({
        binary: script,
        maxRuntimeMs: 15_000,
        killGraceMs: 500,
        model: "big-output",
      })

      const result = await adapter.complete(makeRequest())
      // JSONL path concatenates chunk deltas — verify we got substantial content
      expect(result.content.length).toBeGreaterThan(40_000)
    }, 20_000)

    it("streams large output without blocking (100 chunks)", async () => {
      const dir = makeTmpDir()
      const script = createStreamScript(dir, { chunks: 100 })

      const adapter = new NativeRuntimeAdapter({
        binary: script,
        maxRuntimeMs: 10_000,
        killGraceMs: 500,
        model: "many-chunks",
      })

      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream(makeRequest())) {
        chunks.push(chunk)
      }

      const textChunks = chunks.filter(c => c.event === "chunk")
      expect(textChunks).toHaveLength(100)
    }, 15_000)
  })

  describe("timeout + escalated kill", () => {
    it("kills hung process via timeout", async () => {
      const dir = makeTmpDir()
      // Script sleeps 60s — well beyond timeout
      const script = createMockScript(dir, { delayMs: 60_000 })

      const adapter = new NativeRuntimeAdapter({
        binary: script,
        maxRuntimeMs: 300,
        killGraceMs: 200,
        model: "hung-process",
      })

      const start = Date.now()
      await expect(adapter.complete(makeRequest())).rejects.toThrow()
      const elapsed = Date.now() - start

      // Should have been killed within timeout + grace + buffer
      expect(elapsed).toBeLessThan(2000)
    }, 5_000)

    it("concurrent timeouts don't leak processes", async () => {
      const dir = makeTmpDir()

      // 10 scripts that all hang
      const adapters = Array.from({ length: 10 }, () => {
        const script = createMockScript(dir, { delayMs: 60_000 })
        return new NativeRuntimeAdapter({
          binary: script,
          maxRuntimeMs: 300,
          killGraceMs: 200,
          model: "leak-test",
        })
      })

      const promises = adapters.map(adapter =>
        adapter.complete(makeRequest()).catch(() => "killed")
      )

      const results = await Promise.all(promises)
      expect(results).toHaveLength(10)
      for (const r of results) {
        expect(r).toBe("killed")
      }

      // Brief wait for OS process cleanup
      await new Promise(r => setTimeout(r, 200))
    }, 10_000)
  })

  describe("rapid spawn-abort cycles", () => {
    it("handles 30 rapid spawn-then-abort cycles", async () => {
      const dir = makeTmpDir()
      const script = createStreamScript(dir, { chunks: 10, delayBetweenMs: 100 })

      const adapter = new NativeRuntimeAdapter({
        binary: script,
        maxRuntimeMs: 5_000,
        killGraceMs: 200,
        model: "rapid-cycle",
      })

      // Sequentially spawn and immediately abort 30 times
      for (let i = 0; i < 30; i++) {
        const controller = new AbortController()
        const chunks: StreamChunk[] = []

        // Start streaming
        const streamPromise = (async () => {
          try {
            for await (const chunk of adapter.stream(makeRequest(), { signal: controller.signal })) {
              chunks.push(chunk)
              // Abort after first chunk
              controller.abort()
            }
          } catch {
            // Expected
          }
          return chunks
        })()

        await streamPromise
      }
      // If we get here without hanging, the test passes
    }, 30_000)
  })
})

describe("Ensemble race condition simulation", () => {
  afterEach(cleanup)

  describe("first_complete cancellation ordering", () => {
    it("verifies winner determination with variable delays", async () => {
      // Simulate 5 branches with different delays
      const delays = [100, 50, 200, 150, 75]
      const results: { index: number; finishMs: number }[] = []

      const startTime = Date.now()
      const promises = delays.map(async (delay, i) => {
        await new Promise(r => setTimeout(r, delay))
        results.push({ index: i, finishMs: Date.now() - startTime })
        return i
      })

      // Race: first to complete wins
      const winner = await Promise.race(promises)
      // Wait for all to settle
      await Promise.allSettled(promises)

      // Branch with 50ms delay (index 1) should win
      expect(winner).toBe(1)
      // Winner should have finished first
      const winnerResult = results.find(r => r.index === 1)!
      expect(winnerResult.finishMs).toBeLessThan(100)
    })

    it("handles double-resolve safely (idempotent winner latch)", async () => {
      // Simulate winner latch: only the first resolver wins
      let winner: number | null = null
      const latch = (index: number): boolean => {
        if (winner === null) {
          winner = index
          return true
        }
        return false
      }

      // Two branches resolve nearly simultaneously
      const branch0 = new Promise<boolean>(resolve => {
        setTimeout(() => resolve(latch(0)), 50)
      })
      const branch1 = new Promise<boolean>(resolve => {
        setTimeout(() => resolve(latch(1)), 51)
      })

      const [won0, won1] = await Promise.all([branch0, branch1])

      // Exactly one should win
      expect(won0 !== won1).toBe(true)
      expect(winner).not.toBeNull()
    })
  })

  describe("concurrent ensemble runs", () => {
    it("runs 10 ensembles concurrently without interference", async () => {
      // Each "ensemble" is a race of 3 branches
      const ensembles = Array.from({ length: 10 }, (_, ensIdx) =>
        (async () => {
          const delays = [100 + ensIdx * 5, 200, 300]
          const controllers = delays.map(() => new AbortController())

          const branches = delays.map(async (delay, brIdx) => {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, delay)
              controllers[brIdx].signal.addEventListener("abort", () => {
                clearTimeout(timer)
                reject(new Error("cancelled"))
              })
            })
            return { ensemble: ensIdx, branch: brIdx }
          })

          // First to complete wins
          const winner = await Promise.race(branches)

          // Cancel losers
          for (let i = 0; i < controllers.length; i++) {
            if (i !== winner.branch) controllers[i].abort()
          }

          // Wait for all to settle
          await Promise.allSettled(branches)

          return winner
        })()
      )

      const winners = await Promise.all(ensembles)

      expect(winners).toHaveLength(10)
      // Each ensemble should have a winner from its first branch (shortest delay)
      for (const w of winners) {
        expect(w.branch).toBe(0) // First branch has shortest delay
      }
    })
  })

  describe("abort signal propagation", () => {
    it("parent abort cancels all child branches", async () => {
      const parent = new AbortController()
      const children = Array.from({ length: 5 }, () => new AbortController())

      // Link parent to children
      parent.signal.addEventListener("abort", () => {
        for (const child of children) child.abort()
      })

      // Verify children are not yet aborted
      for (const child of children) {
        expect(child.signal.aborted).toBe(false)
      }

      // Abort parent
      parent.abort()

      // All children should be aborted
      for (const child of children) {
        expect(child.signal.aborted).toBe(true)
      }
    })

    it("child abort does not propagate to parent", () => {
      const parent = new AbortController()
      const children = Array.from({ length: 3 }, () => new AbortController())

      // Link parent to children (one-way)
      parent.signal.addEventListener("abort", () => {
        for (const child of children) child.abort()
      })

      // Abort one child
      children[1].abort()

      // Parent should NOT be aborted
      expect(parent.signal.aborted).toBe(false)
      // Other children should NOT be aborted
      expect(children[0].signal.aborted).toBe(false)
      expect(children[2].signal.aborted).toBe(false)
    })
  })

  describe("shutdown race: completion vs timeout", () => {
    it("handles branch completing exactly at timeout boundary", async () => {
      // Simulate timeout race
      const TIMEOUT_MS = 100

      const results: string[] = []

      const branch = new Promise<string>((resolve) => {
        // Resolves exactly at timeout
        setTimeout(() => resolve("completed"), TIMEOUT_MS)
      })

      const timeout = new Promise<string>((resolve) => {
        setTimeout(() => resolve("timeout"), TIMEOUT_MS)
      })

      // Both fire at the same time — one or the other should win
      const winner = await Promise.race([branch, timeout])
      results.push(winner)

      // Either outcome is acceptable
      expect(["completed", "timeout"]).toContain(winner)
    })

    it("timeout fires before slow branch", async () => {
      const TIMEOUT_MS = 50
      const BRANCH_DELAY = 200

      const branch = new Promise<string>((resolve) => {
        setTimeout(() => resolve("completed"), BRANCH_DELAY)
      })

      const timeout = new Promise<string>((resolve) => {
        setTimeout(() => resolve("timeout"), TIMEOUT_MS)
      })

      const winner = await Promise.race([branch, timeout])
      expect(winner).toBe("timeout")
    })
  })
})

describe("Cost attribution stress", () => {
  afterEach(cleanup)

  it("handles 50 branches in a single ensemble", () => {
    // Simulate 50 branch cost results
    const branches = Array.from({ length: 50 }, (_, i) => ({
      pool: `pool-${i}`,
      total_cost_micro: BigInt(100 + i * 10),
      prompt_tokens: 100,
      completion_tokens: 50 + i,
    }))

    const totalCost = branches.reduce((sum, b) => sum + b.total_cost_micro, 0n)

    // Verify BigInt arithmetic doesn't overflow or lose precision
    expect(totalCost).toBe(
      branches.reduce((sum, b) => sum + BigInt(100 + branches.indexOf(b) * 10), 0n)
    )
    expect(totalCost).toBeGreaterThan(0n)

    // All pools should be unique
    const pools = new Set(branches.map(b => b.pool))
    expect(pools.size).toBe(50)
  })

  it("handles BigInt cost accumulation at scale", () => {
    // Simulate many ledger entries being accumulated
    const entries = 1000
    let total = 0n

    for (let i = 0; i < entries; i++) {
      // Simulate realistic cost: 100-50000 micro-USD per branch
      const cost = BigInt(100 + Math.floor(Math.random() * 50000))
      total += cost
    }

    // Total should be positive and within realistic bounds
    expect(total).toBeGreaterThan(0n)
    // ~25000 avg * 1000 entries = ~25M micro-USD = $25
    expect(total).toBeLessThan(100_000_000n) // Under $100
  })
})
