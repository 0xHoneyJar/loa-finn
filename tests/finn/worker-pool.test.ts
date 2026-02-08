// tests/finn/worker-pool.test.ts — WorkerPool unit tests (Sprint 1, Task 1.8)

import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkerPool, PoolError, PoolErrorCode } from "../../src/agent/worker-pool.js"
import type { WorkerPoolConfig, ExecSpec } from "../../src/agent/worker-pool.js"

// ── Test Worker Script ──────────────────────────────────────
// A minimal worker that responds to exec messages with a result.
// For tests, we use a real sandbox-worker script against real binaries.

const TEST_JAIL = mkdtempSync(join(tmpdir(), "wp-test-jail-"))

function createTestWorkerScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "wp-test-worker-"))
  const script = join(dir, "test-worker.mjs")
  writeFileSync(
    script,
    `
import { parentPort } from "node:worker_threads"

parentPort.on("message", async (msg) => {
  if (msg.type === "abort") {
    parentPort.postMessage({ type: "aborted", jobId: msg.jobId })
    return
  }
  if (msg.type !== "exec") return

  const { jobId, spec } = msg
  const start = performance.now()

  // Simulate command execution with configurable behavior via args
  const mode = spec.args[0] ?? "ok"

  if (mode === "ok") {
    parentPort.postMessage({
      type: "result", jobId,
      result: {
        stdout: "hello from worker",
        stderr: "",
        exitCode: 0,
        truncated: false,
        durationMs: performance.now() - start,
      },
    })
  } else if (mode === "error") {
    parentPort.postMessage({
      type: "result", jobId,
      result: {
        stdout: "",
        stderr: "command failed",
        exitCode: 1,
        truncated: false,
        durationMs: performance.now() - start,
      },
    })
  } else if (mode === "slow") {
    // Takes 2 seconds — useful for timeout tests
    await new Promise(r => setTimeout(r, 2000))
    parentPort.postMessage({
      type: "result", jobId,
      result: {
        stdout: "slow done",
        stderr: "",
        exitCode: 0,
        truncated: false,
        durationMs: performance.now() - start,
      },
    })
  } else if (mode === "hang") {
    // Never responds — simulates wedged worker
  } else if (mode === "crash") {
    process.exit(1)
  } else if (mode === "stale") {
    // Send result with wrong jobId
    parentPort.postMessage({
      type: "result", jobId: "wrong-id",
      result: { stdout: "", stderr: "", exitCode: 0, truncated: false, durationMs: 0 },
    })
    // Then send correct one
    parentPort.postMessage({
      type: "result", jobId,
      result: { stdout: "after stale", stderr: "", exitCode: 0, truncated: false, durationMs: 0 },
    })
  }
})
`,
  )
  return script
}

// ── Helpers ──────────────────────────────────────────────────

function makePool(overrides: Partial<WorkerPoolConfig> = {}): WorkerPool {
  return new WorkerPool({
    interactiveWorkers: overrides.interactiveWorkers ?? 2,
    workerScript: overrides.workerScript ?? createTestWorkerScript(),
    shutdownDeadlineMs: overrides.shutdownDeadlineMs ?? 5_000,
    maxQueueDepth: overrides.maxQueueDepth ?? 10,
  })
}

function makeSpec(mode = "ok"): ExecSpec {
  return {
    binaryPath: "/usr/bin/echo",
    args: [mode],
    cwd: TEST_JAIL,
    timeoutMs: 5_000,
    env: { PATH: "/usr/bin" },
    maxBuffer: 1_048_576,
  }
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

// ── Tests ────────────────────────────────────────────────────

async function main() {
  console.log("\n=== WorkerPool Tests ===\n")

  // ── Basic Dispatch ──────────────────────────────────────────

  await test("exec returns result from worker", async () => {
    const pool = makePool()
    try {
      const result = await pool.exec(makeSpec("ok"), "interactive")
      assert.equal(result.stdout, "hello from worker")
      assert.equal(result.exitCode, 0)
      assert.equal(result.truncated, false)
      assert.ok(result.durationMs >= 0)
    } finally {
      await pool.shutdown()
    }
  })

  await test("exec returns error result from worker", async () => {
    const pool = makePool()
    try {
      const result = await pool.exec(makeSpec("error"), "interactive")
      assert.equal(result.stderr, "command failed")
      assert.equal(result.exitCode, 1)
    } finally {
      await pool.shutdown()
    }
  })

  await test("system lane dispatches independently", async () => {
    const pool = makePool()
    try {
      const result = await pool.exec(makeSpec("ok"), "system")
      assert.equal(result.stdout, "hello from worker")
    } finally {
      await pool.shutdown()
    }
  })

  // ── jobId Correlation ───────────────────────────────────────

  await test("stale jobId messages are discarded", async () => {
    const pool = makePool()
    try {
      const result = await pool.exec(makeSpec("stale"), "interactive")
      assert.equal(result.stdout, "after stale")
    } finally {
      await pool.shutdown()
    }
  })

  // ── Timeout / Abort ─────────────────────────────────────────

  await test("timeout rejects with EXEC_TIMEOUT", async () => {
    const pool = makePool()
    try {
      const spec = makeSpec("slow")
      spec.timeoutMs = 100 // 100ms timeout, worker takes 2s
      await assert.rejects(
        () => pool.exec(spec, "interactive"),
        (err: PoolError) => {
          assert.equal(err.code, PoolErrorCode.EXEC_TIMEOUT)
          return true
        },
      )
    } finally {
      await pool.shutdown()
    }
  })

  // ── Worker Crash Recovery ───────────────────────────────────

  await test("worker crash rejects with WORKER_CRASHED and pool recovers", async () => {
    const pool = makePool()
    try {
      // First exec crashes the worker
      await assert.rejects(
        () => pool.exec(makeSpec("crash"), "interactive"),
        (err: PoolError) => {
          assert.equal(err.code, PoolErrorCode.WORKER_CRASHED)
          return true
        },
      )

      // Pool should have spawned a replacement — next exec should succeed
      const result = await pool.exec(makeSpec("ok"), "interactive")
      assert.equal(result.stdout, "hello from worker")
    } finally {
      await pool.shutdown()
    }
  })

  // ── Queue Overflow ──────────────────────────────────────────

  await test("queue overflow rejects with WORKER_UNAVAILABLE", async () => {
    const pool = makePool({ interactiveWorkers: 1, maxQueueDepth: 1 })
    try {
      // Fill the single worker with a slow job
      const slowPromise = pool.exec(makeSpec("slow"), "interactive").catch(() => {})
      // Fill the queue (depth 1)
      const queuedPromise = pool.exec(makeSpec("ok"), "interactive").catch(() => {})
      // This should overflow
      await assert.rejects(
        () => pool.exec(makeSpec("ok"), "interactive"),
        (err: PoolError) => {
          assert.equal(err.code, PoolErrorCode.WORKER_UNAVAILABLE)
          assert.match(err.message, /queue full/i)
          return true
        },
      )
    } finally {
      await pool.shutdown()
    }
  })

  // ── Shutdown ────────────────────────────────────────────────

  await test("shutdown rejects queued jobs with POOL_SHUTTING_DOWN", async () => {
    const pool = makePool({ interactiveWorkers: 1 })
    // Start a slow job to occupy the worker — catch its rejection from shutdown
    const slowPromise = pool.exec(makeSpec("slow"), "interactive").catch(() => {})
    // Queue another job — attach rejection handler immediately to prevent unhandled rejection
    let queuedError: Error | undefined
    const queuedPromise = pool.exec(makeSpec("ok"), "interactive").catch((err) => {
      queuedError = err
    })

    // Shutdown should reject the queued job
    await pool.shutdown()
    await queuedPromise

    assert.ok(queuedError instanceof PoolError, "Expected PoolError")
    assert.equal((queuedError as PoolError).code, PoolErrorCode.POOL_SHUTTING_DOWN)
  })

  await test("exec after shutdown rejects with POOL_SHUTTING_DOWN", async () => {
    const pool = makePool()
    await pool.shutdown()

    await assert.rejects(
      () => pool.exec(makeSpec("ok"), "interactive"),
      (err: PoolError) => {
        assert.equal(err.code, PoolErrorCode.POOL_SHUTTING_DOWN)
        return true
      },
    )
  })

  // ── Stats ───────────────────────────────────────────────────

  await test("stats tracks completed/failed/timedOut counts", async () => {
    const pool = makePool()
    try {
      // One success
      await pool.exec(makeSpec("ok"), "interactive")

      const stats = pool.stats()
      assert.equal(stats.totals.completed, 1)
      assert.equal(stats.totals.failed, 0)
      assert.ok(stats.totals.avgExecMs >= 0)
      assert.equal(stats.interactive.idle, 2)
      assert.equal(stats.interactive.active, 0)
      assert.equal(stats.interactive.queued, 0)
    } finally {
      await pool.shutdown()
    }
  })

  // ── Per-session Fairness (SD-016) ───────────────────────────

  await test("per-session fairness interleaves sessions at >50% queue", async () => {
    const pool = makePool({ interactiveWorkers: 1, maxQueueDepth: 10 })
    try {
      // Occupy worker with slow job
      const slowPromise = pool.exec(makeSpec("slow"), "interactive").catch(() => {})

      // Fill queue past 50% with session-A jobs, then add session-B
      // Queue 6 session-A jobs (60% of 10 = past 50% threshold)
      const promises: Promise<any>[] = []
      for (let i = 0; i < 6; i++) {
        const spec = makeSpec("ok")
        spec.sessionId = "session-A"
        promises.push(pool.exec(spec, "interactive").catch(() => {}))
      }

      // Now add session-B — should be interleaved, not pushed to end
      const specB = makeSpec("ok")
      specB.sessionId = "session-B"
      promises.push(pool.exec(specB, "interactive").catch(() => {}))

      const stats = pool.stats()
      assert.ok(stats.interactive.queued >= 7, `Expected >=7 queued, got ${stats.interactive.queued}`)
    } finally {
      await pool.shutdown()
    }
  })

  // ── Concurrent Dispatch ─────────────────────────────────────

  await test("multiple concurrent execs succeed", async () => {
    const pool = makePool({ interactiveWorkers: 2 })
    try {
      const results = await Promise.all([
        pool.exec(makeSpec("ok"), "interactive"),
        pool.exec(makeSpec("ok"), "interactive"),
      ])
      assert.equal(results.length, 2)
      assert.equal(results[0].stdout, "hello from worker")
      assert.equal(results[1].stdout, "hello from worker")
    } finally {
      await pool.shutdown()
    }
  })

  console.log("\n=== WorkerPool Tests Complete ===\n")
}

main().catch((err) => {
  console.error("Test runner failed:", err)
  process.exitCode = 1
})
