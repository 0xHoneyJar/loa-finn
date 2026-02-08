// src/agent/sandbox-worker.ts — Stateless worker thread executor (SDD §3.2, Cycle 005)
//
// Receives ExecSpec via parentPort, spawns child process with detached:true,
// returns ExecResult with jobId correlation. No policy, no audit log, no secrets.
//
// Platform note: detached:true uses setsid on Linux/macOS to create a new process
// group. On Windows (not a deployment target), detached creates a new console.
// We skip -pid kill on Windows and use child.kill() instead.

import { parentPort } from "node:worker_threads"
import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process"
import { realpath } from "node:fs/promises"
import { relative, isAbsolute, sep, resolve as resolvePath } from "node:path"
import type { ChildProcess } from "node:child_process"

const TRUNCATION_MARKER = "\n[TRUNCATED at maxBuffer]"
const isWindows = process.platform === "win32"

// Defense-in-depth: re-check cwd is within expected jail using path.relative
async function validateCwd(cwd: string, jailRoot: string): Promise<void> {
  const cwdAbs = resolvePath(cwd)
  const jailAbs = resolvePath(jailRoot)

  const cwdReal = await realpath(cwdAbs)
  const jailReal = await realpath(jailAbs)

  const rel = relative(jailReal, cwdReal)
  // rel === "" means cwd IS the jail root — allowed
  if (rel === "") return
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`cwd ${cwdReal} escapes jail ${jailReal}`)
  }
}

// Kill child process group (or just child on Windows)
function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    if (isWindows) {
      child.kill(signal)
    } else {
      process.kill(-child.pid, signal)
    }
  } catch {
    // Process may already be dead
  }
}

// Truncate stdout+stderr to fit within maxBuffer cap, appending marker
function truncateToMaxBuffer(
  stdout: string,
  stderr: string,
  maxBuffer: number,
): { stdout: string; stderr: string; truncated: boolean } {
  const max = Math.max(0, maxBuffer | 0)
  const totalLen = stdout.length + stderr.length
  if (totalLen <= max) return { stdout, stderr, truncated: false }

  const budget = Math.max(0, max - TRUNCATION_MARKER.length)
  let out = stdout
  let err = stderr

  if (out.length > budget) {
    out = out.slice(0, budget) + TRUNCATION_MARKER
    err = ""
  } else {
    const remaining = budget - out.length
    err = err.slice(0, remaining) + TRUNCATION_MARKER
  }

  return { stdout: out, stderr: err, truncated: true }
}

// Map common signals to numbers for exit code calculation (128 + signal)
function signalNumber(sig: NodeJS.Signals): number {
  switch (sig) {
    case "SIGKILL": return 9
    case "SIGTERM": return 15
    case "SIGINT": return 2
    default: return 0
  }
}

// Track in-flight child process for explicit kill on abort
let currentChild: ChildProcess | null = null
let currentJobId: string | null = null
// Records abort requests that arrive before the child is spawned (keyed per jobId)
const pendingAborts = new Set<string>()

if (!parentPort) {
  throw new Error("sandbox-worker must be run as a worker thread")
}

parentPort.on("message", async (msg) => {
  // ── Abort handler ────────────────────────────────────────
  // Processed BEFORE exec so that aborts arriving during the spawn window
  // are captured via abortRequestedForJobId.
  if (msg.type === "abort") {
    pendingAborts.add(msg.jobId)

    if (msg.jobId === currentJobId) {
      if (currentChild?.pid) {
        killChild(currentChild, "SIGTERM")

        // Escalate to SIGKILL after 5s if child hasn't exited
        const killTimer = setTimeout(() => {
          if (currentChild?.pid) {
            killChild(currentChild, "SIGKILL")
          }
        }, 5_000)

        // Wait for close event before posting aborted — ensures no orphan
        currentChild.once("close", () => {
          clearTimeout(killTimer)
          currentChild = null
          currentJobId = null
          pendingAborts.delete(msg.jobId)
          parentPort!.postMessage({ type: "aborted", jobId: msg.jobId })
        })
      } else {
        // No child in flight — acknowledge immediately
        currentJobId = null
        pendingAborts.delete(msg.jobId)
        parentPort!.postMessage({ type: "aborted", jobId: msg.jobId })
      }
    } else {
      // Not the current job — always acknowledge so caller doesn't hang
      pendingAborts.delete(msg.jobId)
      parentPort!.postMessage({ type: "aborted", jobId: msg.jobId })
    }
    return
  }

  // ── Exec handler ─────────────────────────────────────────
  if (msg.type !== "exec") return

  const { jobId, spec, jailRoot } = msg
  currentJobId = jobId

  // If an abort already arrived for this job, do not start it
  if (pendingAborts.has(jobId)) {
    currentJobId = null
    pendingAborts.delete(jobId)
    parentPort!.postMessage({ type: "aborted", jobId })
    return
  }

  try {
    await validateCwd(spec.cwd, jailRoot)
  } catch (err) {
    // Log detailed error for internal diagnostics but return sanitized
    // message to prevent jail path disclosure to callers (SD-011)
    console.error(`[sandbox-worker] cwd validation failed: ${(err as Error).message}`)
    currentJobId = null
    parentPort!.postMessage({
      type: "result",
      jobId,
      result: {
        stdout: "",
        stderr: "Working directory validation failed",
        exitCode: 1,
        truncated: false,
        durationMs: 0,
      },
    })
    return
  }

  // 2x main-thread timeout as safety ceiling — main thread is authoritative for
  // deadline enforcement (SDD §3.2). Worker ceiling is a backstop only.
  const safetyCeiling = spec.timeoutMs * 2

  const start = performance.now()
  try {
    const result = await new Promise<{
      stdout: string
      stderr: string
      status: number | null
    }>((resolve, reject) => {
      const child = execFile(
        spec.binaryPath,
        spec.args,
        {
          cwd: spec.cwd,
          env: spec.env,
          maxBuffer: spec.maxBuffer,
          timeout: safetyCeiling,
          encoding: "utf-8",
          killSignal: "SIGKILL",
          detached: !isWindows, // setsid on Linux/macOS for process group kill
        } as ExecFileOptionsWithStringEncoding & { detached: boolean },
        (err: any, stdout: string, stderr: string) => {
          if (err) {
            reject(Object.assign(err, { stdout, stderr }))
            return
          }
          resolve({ stdout, stderr, status: child.exitCode })
        },
      )

      currentChild = child

      // If abort arrived during spawn window, kill immediately
      if (pendingAborts.has(jobId) && currentChild?.pid) {
        killChild(currentChild, "SIGTERM")
      }
    })

    // Enforce maxBuffer cap on all posted messages
    const truncated = truncateToMaxBuffer(result.stdout, result.stderr, spec.maxBuffer)

    parentPort!.postMessage({
      type: "result",
      jobId,
      result: {
        stdout: truncated.stdout,
        stderr: truncated.stderr,
        exitCode: result.status ?? 0,
        truncated: truncated.truncated,
        durationMs: performance.now() - start,
      },
    })
  } catch (err: unknown) {
    const durationMs = performance.now() - start
    const execErr = err as NodeJS.ErrnoException & {
      stdout?: string
      stderr?: string
      code?: string
      killed?: boolean
      signal?: NodeJS.Signals
      status?: number | null
    }

    let stdout = execErr.stdout ?? ""
    let stderr = execErr.stderr ?? ""

    // Always enforce postMessage payload cap
    const truncated = truncateToMaxBuffer(stdout, stderr, spec.maxBuffer)
    stdout = truncated.stdout
    stderr = truncated.stderr

    let exitCode = 1
    if (typeof execErr.status === "number") {
      exitCode = execErr.status
    } else if (execErr.signal) {
      exitCode = 128 + signalNumber(execErr.signal)
    } else if (execErr.killed) {
      exitCode = 137 // SIGKILL convention
    }

    parentPort!.postMessage({
      type: "result",
      jobId,
      result: { stdout, stderr, exitCode, truncated: truncated.truncated, durationMs },
    })
  } finally {
    currentChild = null
    currentJobId = null
    pendingAborts.delete(jobId)
  }
})
