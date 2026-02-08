// tests/finn/event-loop-freedom.test.ts — Event loop freedom perf test harness (Sprint 2, Task 2.8)
// Validates PRD §2 success metrics:
//   - Event loop blockage during tool exec: 0%
//   - Scheduler tick jitter: <100ms
//   - WebSocket ping/pong: 100% survival during long command
//
// Uses monitorEventLoopDelay, setInterval jitter measurement, and local WS ping/pong.
// Produces structured JSON results for CI artifacts.

import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks"
import { createServer } from "node:http"
import { WebSocketServer, WebSocket } from "ws"
import { WorkerPool } from "../../src/agent/worker-pool.js"
import type { ExecSpec } from "../../src/agent/worker-pool.js"

// ── Test Worker ──────────────────────────────────────────────

function createTestWorkerScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "perf-test-worker-"))
  const script = join(dir, "worker.mjs")
  writeFileSync(script, `
import { parentPort } from "node:worker_threads"
import { execFile } from "node:child_process"

const isWindows = process.platform === "win32"
let currentChild = null
let currentJobId = null
const pendingAborts = new Set()

function killChild(child, signal) {
  if (!child.pid) return
  try {
    if (isWindows) child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {}
}

parentPort.on("message", async (msg) => {
  if (msg.type === "abort") {
    pendingAborts.add(msg.jobId)
    if (msg.jobId === currentJobId && currentChild?.pid) {
      killChild(currentChild, "SIGTERM")
      currentChild.once("close", () => {
        currentChild = null; currentJobId = null
        pendingAborts.delete(msg.jobId)
        parentPort.postMessage({ type: "aborted", jobId: msg.jobId })
      })
    } else {
      pendingAborts.delete(msg.jobId)
      parentPort.postMessage({ type: "aborted", jobId: msg.jobId })
    }
    return
  }
  if (msg.type !== "exec") return

  const { jobId, spec } = msg
  currentJobId = jobId
  if (pendingAborts.has(jobId)) {
    currentJobId = null; pendingAborts.delete(jobId)
    parentPort.postMessage({ type: "aborted", jobId })
    return
  }

  const start = performance.now()
  try {
    const result = await new Promise((resolve, reject) => {
      const child = execFile(spec.binaryPath, spec.args, {
        cwd: spec.cwd, env: spec.env, maxBuffer: spec.maxBuffer,
        timeout: spec.timeoutMs * 2, encoding: "utf-8", killSignal: "SIGKILL",
        detached: !isWindows,
      }, (err, stdout, stderr) => {
        if (err) { reject(Object.assign(err, { stdout, stderr })); return }
        resolve({ stdout, stderr, status: child.exitCode })
      })
      currentChild = child
    })
    parentPort.postMessage({ type: "result", jobId, result: {
      stdout: result.stdout, stderr: result.stderr,
      exitCode: result.status ?? 0, truncated: false,
      durationMs: performance.now() - start,
    }})
  } catch (err) {
    const durationMs = performance.now() - start
    let exitCode = 1
    if (typeof err.status === "number") exitCode = err.status
    else if (err.signal) {
      const sigMap = { SIGKILL: 9, SIGTERM: 15, SIGINT: 2 }
      exitCode = 128 + (sigMap[err.signal] || 0)
    } else if (err.killed) exitCode = 137
    parentPort.postMessage({ type: "result", jobId, result: {
      stdout: err.stdout ?? "", stderr: err.stderr ?? "",
      exitCode, truncated: false, durationMs,
    }})
  } finally {
    currentChild = null; currentJobId = null; pendingAborts.delete(jobId)
  }
})
`)
  return script
}

// ── Helpers ──────────────────────────────────────────────────

function resolveBinary(name: string): string {
  const { execFileSync } = await_import_child_process()
  try {
    return execFileSync("which", [name], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "" } }).trim()
  } catch {
    return name
  }
}

// Workaround: dynamic import at module level
import { execFileSync } from "node:child_process"
function await_import_child_process() { return { execFileSync } }

interface PerfResult {
  metric: string
  value: number
  unit: string
  threshold: number
  pass: boolean
}

async function test(name: string, fn: () => Promise<void>) {
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
  console.log("Event Loop Freedom & Keepalive Perf Tests")
  console.log("==========================================")
  console.log("(PRD §2 success metrics validation)")

  const workerScript = createTestWorkerScript()
  const pool = new WorkerPool({
    interactiveWorkers: 1,
    workerScript,
    shutdownDeadlineMs: 15_000,
    maxQueueDepth: 10,
  })

  const results: PerfResult[] = []
  const cwd = mkdtempSync(join(tmpdir(), "perf-jail-"))

  try {

  // ── 1. Event Loop Delay (monitorEventLoopDelay) ───────────

  console.log("\n--- Event Loop Delay ---")

  await test("p99 event loop delay < 50ms during 3s sleep", async () => {
    // Use 3s sleep (shorter than 10s for test speed, still proves non-blocking)
    const sleepBin = resolveBinary("sleep")

    const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: 10 })
    histogram.enable()

    const spec: ExecSpec = {
      binaryPath: sleepBin,
      args: ["3"],
      cwd,
      timeoutMs: 15_000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/usr/local/bin" },
      maxBuffer: 1_048_576,
    }

    const result = await pool.exec(spec, "interactive")

    histogram.disable()

    const p99Ms = histogram.percentile(99) / 1e6 // ns → ms
    const maxMs = histogram.max / 1e6

    results.push({
      metric: "event_loop_p99_ms",
      value: Math.round(p99Ms * 100) / 100,
      unit: "ms",
      threshold: 50,
      pass: p99Ms < 50,
    })
    results.push({
      metric: "event_loop_max_ms",
      value: Math.round(maxMs * 100) / 100,
      unit: "ms",
      threshold: 100,
      pass: maxMs < 100,
    })

    assert.equal(result.exitCode, 0, "sleep should exit 0")
    assert.ok(p99Ms < 50, `p99 event loop delay ${p99Ms.toFixed(2)}ms exceeds 50ms threshold`)

    console.log(`    p99=${p99Ms.toFixed(2)}ms, max=${maxMs.toFixed(2)}ms`)
  })

  // ── 2. Scheduler Tick Jitter ──────────────────────────────

  console.log("\n--- Scheduler Tick Jitter ---")

  await test("setInterval(100ms) jitter < 100ms during 3s sleep", async () => {
    const sleepBin = resolveBinary("sleep")

    const tickTimestamps: number[] = []
    const interval = setInterval(() => {
      tickTimestamps.push(performance.now())
    }, 100)

    const spec: ExecSpec = {
      binaryPath: sleepBin,
      args: ["3"],
      cwd,
      timeoutMs: 15_000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/usr/local/bin" },
      maxBuffer: 1_048_576,
    }

    const result = await pool.exec(spec, "interactive")

    clearInterval(interval)

    assert.equal(result.exitCode, 0, "sleep should exit 0")
    assert.ok(tickTimestamps.length >= 10, `Expected ≥10 interval ticks in 3s, got ${tickTimestamps.length}`)

    // Measure inter-tick deltas
    const deltas: number[] = []
    for (let i = 1; i < tickTimestamps.length; i++) {
      deltas.push(tickTimestamps[i] - tickTimestamps[i - 1])
    }

    const maxDelta = Math.max(...deltas)
    const jitter = maxDelta - 100 // deviation from expected 100ms

    results.push({
      metric: "scheduler_tick_count",
      value: tickTimestamps.length,
      unit: "ticks",
      threshold: 10,
      pass: tickTimestamps.length >= 10,
    })
    results.push({
      metric: "scheduler_max_delta_ms",
      value: Math.round(maxDelta * 100) / 100,
      unit: "ms",
      threshold: 200,
      pass: maxDelta < 200,
    })
    results.push({
      metric: "scheduler_jitter_ms",
      value: Math.round(jitter * 100) / 100,
      unit: "ms",
      threshold: 100,
      pass: jitter < 100,
    })

    assert.ok(maxDelta < 200, `Max interval delta ${maxDelta.toFixed(2)}ms exceeds 200ms (jitter ${jitter.toFixed(2)}ms > 100ms)`)

    console.log(`    ticks=${tickTimestamps.length}, maxDelta=${maxDelta.toFixed(2)}ms, jitter=${jitter.toFixed(2)}ms`)
  })

  // ── 3. WebSocket Ping/Pong Survival ───────────────────────

  console.log("\n--- WebSocket Keepalive ---")

  await test("WebSocket ping/pong survives during 3s sleep (100% survival)", async () => {
    // Start a local WS server that echoes pings as pongs
    const httpServer = createServer()
    const wss = new WebSocketServer({ server: httpServer })

    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve())
    })

    const addr = httpServer.address() as { port: number }

    // Track pong responses
    let pongCount = 0
    let pingCount = 0
    const pongLatencies: number[] = []

    const client = new WebSocket(`ws://127.0.0.1:${addr.port}`)
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve())
      client.on("error", reject)
    })

    client.on("pong", () => {
      pongCount++
      const now = performance.now()
      if (pongLatencies.length > 0) {
        // latency is measured from the last ping send
      }
    })

    // Send pings every 500ms during the sleep
    const pingTimestamps: number[] = []
    const pingInterval = setInterval(() => {
      if (client.readyState === WebSocket.OPEN) {
        pingTimestamps.push(performance.now())
        client.ping()
        pingCount++
      }
    }, 500)

    // Track pong timestamps for latency
    const pongTimestamps: number[] = []
    client.on("pong", () => {
      pongTimestamps.push(performance.now())
    })
    // Remove duplicate handler — pongCount already incremented above
    // The second "pong" listener just records timestamp

    const sleepBin = resolveBinary("sleep")
    const spec: ExecSpec = {
      binaryPath: sleepBin,
      args: ["3"],
      cwd,
      timeoutMs: 15_000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/usr/local/bin" },
      maxBuffer: 1_048_576,
    }

    const execResult = await pool.exec(spec, "interactive")

    clearInterval(pingInterval)

    // Wait a bit for final pongs to arrive
    await new Promise((r) => setTimeout(r, 200))

    // Calculate latencies
    const minLen = Math.min(pingTimestamps.length, pongTimestamps.length)
    for (let i = 0; i < minLen; i++) {
      pongLatencies.push(pongTimestamps[i] - pingTimestamps[i])
    }

    const maxLatency = pongLatencies.length > 0 ? Math.max(...pongLatencies) : 0
    const survivalRate = pingCount > 0 ? (pongCount / pingCount) * 100 : 0

    results.push({
      metric: "ws_ping_count",
      value: pingCount,
      unit: "pings",
      threshold: 3,
      pass: pingCount >= 3,
    })
    results.push({
      metric: "ws_pong_count",
      value: pongCount,
      unit: "pongs",
      threshold: 3,
      pass: pongCount >= 3,
    })
    results.push({
      metric: "ws_survival_rate",
      value: Math.round(survivalRate * 100) / 100,
      unit: "%",
      threshold: 100,
      pass: survivalRate >= 100,
    })
    results.push({
      metric: "ws_max_pong_latency_ms",
      value: Math.round(maxLatency * 100) / 100,
      unit: "ms",
      threshold: 1000,
      pass: maxLatency < 1000,
    })

    assert.equal(execResult.exitCode, 0, "sleep should exit 0")
    assert.ok(pingCount >= 3, `Expected ≥3 pings in 3s, got ${pingCount}`)
    assert.equal(pongCount, pingCount, `All pings should receive pongs: sent=${pingCount}, received=${pongCount}`)
    assert.ok(maxLatency < 1000, `Max pong latency ${maxLatency.toFixed(2)}ms exceeds 1s threshold`)

    console.log(`    pings=${pingCount}, pongs=${pongCount}, survival=${survivalRate.toFixed(0)}%, maxLatency=${maxLatency.toFixed(2)}ms`)

    // Cleanup
    client.close()
    wss.close()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  })

  // ── Structured Results ────────────────────────────────────

  console.log("\n--- Perf Results (CI Artifact) ---")
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    suite: "event-loop-freedom",
    results,
    allPassed: results.every((r) => r.pass),
  }, null, 2))

  console.log("\nDone.")

  } finally {
    rmSync(cwd, { recursive: true, force: true })
    await pool.shutdown()
  }
}

main().catch((err) => {
  console.error("Test runner failed:", err)
  process.exitCode = 1
})
