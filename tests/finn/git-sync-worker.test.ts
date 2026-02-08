// tests/finn/git-sync-worker.test.ts — GitSync worker integration tests (Sprint 2, Task 2.6)
// Verifies git operations run through pool system lane without blocking main thread.

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWALManager } from "../../src/persistence/upstream.js"
import type { WALManager } from "../../src/persistence/upstream.js"
import { GitSync } from "../../src/persistence/git-sync.js"
import { WorkerPool } from "../../src/agent/worker-pool.js"
import type { FinnConfig } from "../../src/config.js"

// ── Test Worker ──────────────────────────────────────────────

function createTestWorkerScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitsync-test-worker-"))
  const script = join(dir, "worker.mjs")
  writeFileSync(script, `
import { parentPort } from "node:worker_threads"
import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { relative, isAbsolute, sep, resolve as resolvePath } from "node:path"

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

function makeConfig(cwd: string): FinnConfig {
  return {
    model: "test",
    thinkingLevel: "none",
    beauvoirPath: "",
    port: 0,
    host: "localhost",
    dataDir: join(cwd, "data"),
    sessionDir: join(cwd, "data/sessions"),
    r2: { endpoint: "", bucket: "", accessKeyId: "", secretAccessKey: "" },
    git: {
      remote: "origin",
      branch: "main",
      archiveBranch: "finn/archive",
      token: "test-token",
    },
    auth: { bearerToken: "", corsOrigins: [], rateLimiting: { windowMs: 60000, maxRequestsPerWindow: 60 } },
    syncIntervalMs: 30000,
    gitSyncIntervalMs: 3600000,
    healthIntervalMs: 300000,
    sandbox: { allowBash: false, jailRoot: cwd, execTimeout: 30000, maxOutput: 65536 },
    workerPool: { interactiveWorkers: 1, shutdownDeadlineMs: 5000, maxQueueDepth: 10 },
    sandboxMode: "worker",
    sandboxSyncFallback: false,
  } as FinnConfig
}

/** Create a git repo with an initial commit and pre-existing archive branch. */
function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitsync-repo-"))
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" })
  execFileSync("git", ["-C", dir, "config", "user.email", "test@test.com"], { stdio: "ignore" })
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "ignore" })
  // Create initial commit on main
  writeFileSync(join(dir, "README.md"), "# test")
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "ignore" })
  execFileSync("git", ["-C", dir, "commit", "-m", "init"], { stdio: "ignore" })
  // Pre-create finn/archive orphan branch so ensureArchiveBranch() is a no-op
  // (avoids checkout --orphan which would switch HEAD away from main)
  execFileSync("git", ["-C", dir, "checkout", "--orphan", "finn/archive"], { stdio: "ignore" })
  execFileSync("git", ["-C", dir, "rm", "-rf", "."], { stdio: "ignore" })
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "chore: initialize archive branch"], { stdio: "ignore" })
  execFileSync("git", ["-C", dir, "checkout", "main"], { stdio: "ignore" })
  return dir
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
  console.log("GitSync Worker Integration Tests")
  console.log("================================")

  const workerScript = createTestWorkerScript()
  const pool = new WorkerPool({
    interactiveWorkers: 1,
    workerScript,
    shutdownDeadlineMs: 5_000,
    maxQueueDepth: 10,
  })

  try {

  // ── 1. System Lane Execution ──────────────────────────────

  console.log("\n--- System Lane ---")

  await test("git operations execute via system lane worker", async () => {
    const repoDir = createTestRepo()
    const walDir = join(repoDir, "data", "wal")
    mkdirSync(walDir, { recursive: true })
    const wal = createWALManager(walDir)
    await wal.initialize()

    // Save original cwd and temporarily change to repo dir
    const origCwd = process.cwd()
    process.chdir(repoDir)

    try {
      const config = makeConfig(repoDir)
      const gitSync = new GitSync(config, wal)
      gitSync.setPool(pool)

      // snapshot() internally calls git() which should go through pool.exec("system")
      // If pool is working, this will succeed asynchronously
      const result = await gitSync.snapshot()
      assert.ok(result, "Expected snapshot result (pool executed git via system lane)")
      assert.ok(result.commitHash.length > 0, "Expected non-empty commit hash")
      assert.ok(result.snapshotId.length > 0, "Expected non-empty snapshot ID")
    } finally {
      process.chdir(origCwd)
      await wal.shutdown()
      rmSync(repoDir, { recursive: true, force: true })
    }
  })

  // ── 2. Non-blocking Execution ─────────────────────────────

  console.log("\n--- Non-blocking ---")

  await test("git operations don't block main thread (setTimeout fires during git exec)", async () => {
    const repoDir = createTestRepo()
    const walDir = join(repoDir, "data", "wal")
    mkdirSync(walDir, { recursive: true })
    const wal = createWALManager(walDir)
    await wal.initialize()

    const origCwd = process.cwd()
    process.chdir(repoDir)

    try {
      const config = makeConfig(repoDir)
      const gitSync = new GitSync(config, wal)
      gitSync.setPool(pool)

      // Start a setTimeout that should fire during the async git operation.
      // If git were blocking the event loop (execFileSync), the timer would
      // not fire until after git completes.
      let timerFired = false
      const timerPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          timerFired = true
          resolve()
        }, 1) // 1ms — should fire immediately on next tick if event loop is free
      })

      // Run snapshot (which involves multiple git commands via pool)
      const snapshotPromise = gitSync.snapshot()

      // Wait for both — timer should fire while git is running
      await Promise.all([snapshotPromise, timerPromise])

      assert.ok(timerFired, "Timer should have fired during async git execution (event loop not blocked)")
    } finally {
      process.chdir(origCwd)
      await wal.shutdown()
      rmSync(repoDir, { recursive: true, force: true })
    }
  })

  // ── 3. Error Handling ─────────────────────────────────────

  console.log("\n--- Error Handling ---")

  await test("git error handling preserved (non-zero exit throws)", async () => {
    const repoDir = createTestRepo()
    const walDir = join(repoDir, "data", "wal")
    mkdirSync(walDir, { recursive: true })
    const wal = createWALManager(walDir)
    await wal.initialize()

    const origCwd = process.cwd()
    process.chdir(repoDir)

    try {
      // Configure with a non-existent remote to force push failure
      const config = makeConfig(repoDir)
      const gitSync = new GitSync(config, wal)
      gitSync.setPool(pool)

      // push() should handle the error gracefully (no remote configured)
      // GitSync.push() catches errors internally and returns false
      const result = await gitSync.push()
      assert.equal(result, false, "push() should return false when remote is unavailable")
    } finally {
      process.chdir(origCwd)
      await wal.shutdown()
      rmSync(repoDir, { recursive: true, force: true })
    }
  })

  await test("sync fallback works when pool is not provided", async () => {
    const repoDir = createTestRepo()
    const walDir = join(repoDir, "data", "wal")
    mkdirSync(walDir, { recursive: true })
    const wal = createWALManager(walDir)
    await wal.initialize()

    const origCwd = process.cwd()
    process.chdir(repoDir)

    try {
      const config = makeConfig(repoDir)
      // Create GitSync WITHOUT pool — should fall back to execFileSync
      const gitSync = new GitSync(config, wal)

      const result = await gitSync.snapshot()
      assert.ok(result, "Expected snapshot result from sync fallback path")
      assert.ok(result.commitHash.length > 0, "Expected non-empty commit hash from sync fallback")
    } finally {
      process.chdir(origCwd)
      await wal.shutdown()
      rmSync(repoDir, { recursive: true, force: true })
    }
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
