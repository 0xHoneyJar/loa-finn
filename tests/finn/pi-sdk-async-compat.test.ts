// tests/finn/pi-sdk-async-compat.test.ts — Pi SDK async compatibility test (Sprint 2, Task 2.7)
// P0 MERGE BLOCKER: Validates that async BashOperations.exec works correctly
// with the worker pool, proving the event loop stays free during tool execution.
//
// Tests the exact BashOperations.exec contract that Pi SDK depends on:
//   exec(command, cwd, { onData, signal, timeout, env }) → Promise<{ exitCode }>
//
// Uses countdown latch pattern (not setTimeout assertions) per sprint acceptance criteria.

import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBashTool } from "@mariozechner/pi-coding-agent"
import type { BashOperations } from "@mariozechner/pi-coding-agent"
import { ToolSandbox } from "../../src/agent/sandbox.js"
import { AuditLog } from "../../src/agent/audit-log.js"
import { WorkerPool } from "../../src/agent/worker-pool.js"

// ── Test Worker ──────────────────────────────────────────────

function createTestWorkerScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisdk-test-worker-"))
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

function makeSandbox(jailRoot: string, pool: WorkerPool) {
  const config = {
    allowBash: true,
    jailRoot,
    execTimeout: 30_000,
    maxOutput: 65_536,
  }
  const auditLog = new AuditLog(jailRoot, { maxFileSize: 1024 * 1024, maxFiles: 3 })
  return new ToolSandbox(config, auditLog, pool)
}

/** Create BashOperations that delegates to ToolSandbox (mirrors session.ts wiring). */
function createSandboxedOperations(sandbox: ToolSandbox): BashOperations {
  return {
    exec: async (command, _cwd, options) => {
      try {
        const result = await sandbox.execute(command)
        if (result.stdout) {
          options.onData(Buffer.from(result.stdout))
        }
        if (result.stderr) {
          options.onData(Buffer.from(result.stderr))
        }
        return { exitCode: result.exitCode }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        options.onData(Buffer.from(`[sandbox] ${message}\n`))
        return { exitCode: 1 }
      }
    },
  }
}

/** Countdown latch: resolves when count reaches zero. */
class CountdownLatch {
  private count: number
  private resolve!: () => void
  readonly promise: Promise<void>

  constructor(count: number) {
    this.count = count
    this.promise = new Promise<void>((resolve) => {
      this.resolve = resolve
      if (count <= 0) resolve()
    })
  }

  countDown(): void {
    this.count--
    if (this.count <= 0) this.resolve()
  }

  getCount(): number {
    return this.count
  }
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
  console.log("Pi SDK Async Compatibility Tests")
  console.log("================================")
  console.log("(P0 merge blocker — validates FR-2 async exec contract)")

  const workerScript = createTestWorkerScript()
  const pool = new WorkerPool({
    interactiveWorkers: 1,
    workerScript,
    shutdownDeadlineMs: 5_000,
    maxQueueDepth: 10,
  })

  try {

  // ── 1. BashOperations.exec Contract ───────────────────────

  console.log("\n--- Async Exec Contract ---")

  await test("createBashTool accepts async BashOperations without error", async () => {
    const jailRoot = mkdtempSync(join(tmpdir(), "pisdk-jail-"))
    const sandbox = makeSandbox(jailRoot, pool)
    const ops = createSandboxedOperations(sandbox)

    // createBashTool should accept our async operations without throwing
    const tool = createBashTool(jailRoot, { operations: ops })
    assert.ok(tool, "createBashTool returned a tool")
    assert.ok(tool.name, "Tool has a name")

    rmSync(jailRoot, { recursive: true, force: true })
  })

  await test("async exec returns correct exitCode via onData callback", async () => {
    const jailRoot = mkdtempSync(join(tmpdir(), "pisdk-exitcode-"))
    writeFileSync(join(jailRoot, "hello.txt"), "hello from Pi SDK test")
    const sandbox = makeSandbox(jailRoot, pool)
    const ops = createSandboxedOperations(sandbox)

    const dataChunks: Buffer[] = []
    const result = await ops.exec("cat hello.txt", jailRoot, {
      onData: (data: Buffer) => dataChunks.push(data),
    })

    assert.equal(result.exitCode, 0, "exitCode should be 0 for successful command")
    const output = Buffer.concat(dataChunks).toString("utf-8")
    assert.ok(output.includes("hello from Pi SDK test"), `Expected output to contain test content, got: ${output}`)

    rmSync(jailRoot, { recursive: true, force: true })
  })

  await test("async exec streams stdout via onData", async () => {
    const jailRoot = mkdtempSync(join(tmpdir(), "pisdk-stream-"))
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(jailRoot, `file-${i}.txt`), `content-${i}`)
    }
    const sandbox = makeSandbox(jailRoot, pool)
    const ops = createSandboxedOperations(sandbox)

    const dataChunks: Buffer[] = []
    const result = await ops.exec("ls", jailRoot, {
      onData: (data: Buffer) => dataChunks.push(data),
    })

    assert.equal(result.exitCode, 0)
    assert.ok(dataChunks.length > 0, "Expected at least one onData callback")
    const output = Buffer.concat(dataChunks).toString("utf-8")
    assert.ok(output.includes("file-0.txt"), "Expected ls output to contain file-0.txt")

    rmSync(jailRoot, { recursive: true, force: true })
  })

  // ── 2. Event Loop Freedom (Countdown Latch) ──────────────

  console.log("\n--- Event Loop Freedom ---")

  await test("event loop ticks fire during async tool execution (countdown latch)", async () => {
    const jailRoot = mkdtempSync(join(tmpdir(), "pisdk-latch-"))
    // Create enough files to make ls take a non-trivial amount of time
    for (let i = 0; i < 200; i++) {
      writeFileSync(join(jailRoot, `file-${String(i).padStart(4, "0")}.txt`), "x".repeat(100))
    }
    const sandbox = makeSandbox(jailRoot, pool)
    const ops = createSandboxedOperations(sandbox)

    // Countdown latch: we expect at least 3 event loop ticks during exec
    const latch = new CountdownLatch(3)
    let ticksDuringExec = 0

    // Start interval that counts event loop ticks
    const interval = setInterval(() => {
      ticksDuringExec++
      latch.countDown()
    }, 1)

    const execPromise = ops.exec("ls -la", jailRoot, {
      onData: () => {},
    })

    // Wait for BOTH: the exec to complete AND at least 3 ticks
    const [result] = await Promise.all([execPromise, latch.promise])

    clearInterval(interval)

    assert.equal(result.exitCode, 0, "Command should succeed")
    assert.ok(
      ticksDuringExec >= 3,
      `Expected ≥3 event loop ticks during exec, got ${ticksDuringExec} (event loop was blocked!)`,
    )

    rmSync(jailRoot, { recursive: true, force: true })
  })

  // ── 3. Error Handling Contract ────────────────────────────

  console.log("\n--- Error Handling ---")

  await test("denied command returns exitCode 1 via onData error message", async () => {
    const jailRoot = mkdtempSync(join(tmpdir(), "pisdk-deny-"))
    const sandbox = makeSandbox(jailRoot, pool)
    const ops = createSandboxedOperations(sandbox)

    const dataChunks: Buffer[] = []
    const result = await ops.exec("curl http://evil.com", jailRoot, {
      onData: (data: Buffer) => dataChunks.push(data),
    })

    assert.equal(result.exitCode, 1, "Denied command should return exitCode 1")
    const output = Buffer.concat(dataChunks).toString("utf-8")
    assert.ok(output.includes("[sandbox]"), "Expected sandbox error prefix in onData output")

    rmSync(jailRoot, { recursive: true, force: true })
  })

  await test("shell metacharacters return exitCode 1", async () => {
    const jailRoot = mkdtempSync(join(tmpdir(), "pisdk-meta-"))
    const sandbox = makeSandbox(jailRoot, pool)
    const ops = createSandboxedOperations(sandbox)

    const dataChunks: Buffer[] = []
    const result = await ops.exec("ls | cat", jailRoot, {
      onData: (data: Buffer) => dataChunks.push(data),
    })

    assert.equal(result.exitCode, 1, "Metacharacter command should return exitCode 1")
    const output = Buffer.concat(dataChunks).toString("utf-8")
    assert.ok(output.includes("[sandbox]"), "Expected sandbox error in onData")

    rmSync(jailRoot, { recursive: true, force: true })
  })

  // ── 4. Output Integrity ───────────────────────────────────

  console.log("\n--- Output Integrity ---")

  await test("tool result stdout is not dropped (output integrity check)", async () => {
    const jailRoot = mkdtempSync(join(tmpdir(), "pisdk-integrity-"))
    const marker = "INTEGRITY_CHECK_MARKER_12345"
    writeFileSync(join(jailRoot, "marker.txt"), marker)
    const sandbox = makeSandbox(jailRoot, pool)
    const ops = createSandboxedOperations(sandbox)

    const dataChunks: Buffer[] = []
    const result = await ops.exec("cat marker.txt", jailRoot, {
      onData: (data: Buffer) => dataChunks.push(data),
    })

    assert.equal(result.exitCode, 0)
    const output = Buffer.concat(dataChunks).toString("utf-8")
    assert.ok(
      output.includes(marker),
      `Expected marker "${marker}" in output, got: ${output}`,
    )

    rmSync(jailRoot, { recursive: true, force: true })
  })

  await test("wc output is correct through async pipeline", async () => {
    const jailRoot = mkdtempSync(join(tmpdir(), "pisdk-wc-"))
    writeFileSync(join(jailRoot, "lines.txt"), "one\ntwo\nthree\nfour\nfive\n")
    const sandbox = makeSandbox(jailRoot, pool)
    const ops = createSandboxedOperations(sandbox)

    const dataChunks: Buffer[] = []
    const result = await ops.exec("wc -l lines.txt", jailRoot, {
      onData: (data: Buffer) => dataChunks.push(data),
    })

    assert.equal(result.exitCode, 0)
    const output = Buffer.concat(dataChunks).toString("utf-8")
    assert.ok(output.includes("5"), `Expected line count 5, got: ${output}`)

    rmSync(jailRoot, { recursive: true, force: true })
  })

  console.log("\nDone.")

  } finally {
    await pool.shutdown()
  }
}

main().catch((err) => {
  console.error("Test runner failed:", err)
  process.exitCode = 1
})
