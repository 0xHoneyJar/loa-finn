// src/hounfour/native-runtime-adapter.ts — NativeRuntime Process Adapter (SDD §4.5, Task B.2)
// Spawns local processes with process group isolation, escalated kill,
// and continuous stream consumption. Implements ModelPort + ModelPortStreaming.

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type {
  ModelPortBase,
  ModelPortStreaming,
  CompletionRequest,
  CompletionResult,
  ModelCapabilities,
  HealthStatus,
  StreamChunk,
  UsageInfo,
} from "./types.js"

const execFileAsync = promisify(execFile)

// --- Runtime Mode Detection (Task 3.3, SDD §4.5) ---

/** Runtime isolation mode for NativeRuntimeAdapter */
export type RuntimeMode = "cgroup" | "process_group" | "degraded"

/**
 * Detect available runtime isolation mode.
 *
 * Priority:
 *   1. cgroup v2 with memory+pids controllers → "cgroup"
 *   2. Process group kill available → "process_group"
 *   3. Fallback → "degraded" (ulimit only)
 */
export function detectRuntimeMode(): RuntimeMode {
  try {
    const controllers = readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf-8")
    if (controllers.includes("memory") && controllers.includes("pids")) {
      return "cgroup"
    }
  } catch {
    // cgroup v2 not available
  }

  // Check process group support (always available on Linux)
  try {
    // process.kill(0, 0) tests if we can signal our own process group
    process.kill(0, 0)
    return "process_group"
  } catch {
    return "degraded"
  }
}

/** Startup probe result for health reporting */
export interface RuntimeProbeResult {
  mode: RuntimeMode
  cgroupAvailable: boolean
  cgroupControllers: string[]
  tiniDetected: boolean
}

/**
 * Run startup probe to detect runtime capabilities.
 * Used by container health checks and adapter initialization.
 */
export function probeRuntime(): RuntimeProbeResult {
  let cgroupAvailable = false
  let cgroupControllers: string[] = []

  try {
    const controllers = readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf-8").trim()
    cgroupAvailable = true
    cgroupControllers = controllers.split(/\s+/)
  } catch {
    // Not available
  }

  // Detect tini (PID 1 in container)
  let tiniDetected = false
  try {
    const comm = readFileSync("/proc/1/comm", "utf-8").trim()
    tiniDetected = comm === "tini"
  } catch {
    // Not in container or /proc not mounted
  }

  return {
    mode: detectRuntimeMode(),
    cgroupAvailable,
    cgroupControllers,
    tiniDetected,
  }
}

// --- Types ---

export interface NativeRuntimeConfig {
  /** Path to the binary/script to execute */
  binary: string
  /** Arguments to pass to the binary */
  args?: string[]
  /** Working directory for the child process */
  cwd?: string
  /** Environment variables (allowlisted — only these are passed) */
  env?: Record<string, string>
  /** Maximum runtime in ms before escalated kill (default: 300000 = 5min) */
  maxRuntimeMs?: number
  /** Grace period in ms between SIGTERM and SIGKILL (default: 5000) */
  killGraceMs?: number
  /** UID to run child as (unprivileged). Omit to inherit. */
  uid?: number
  /** GID to run child as (unprivileged). Omit to inherit. */
  gid?: number
  /** Model name for metadata */
  model?: string
  /** Whether this runtime supports streaming via stdout JSONL */
  streaming?: boolean
  /** Max context tokens for capabilities() */
  maxContextTokens?: number
  /** Max output tokens for capabilities() */
  maxOutputTokens?: number
}

/** JSON-line protocol for stdout communication */
interface NativeOutputLine {
  event: "chunk" | "tool_call" | "usage" | "done" | "error" | "result"
  data: unknown
}

// --- NativeRuntimeAdapter ---

export class NativeRuntimeAdapter implements ModelPortBase, ModelPortStreaming {
  private config: Required<
    Pick<NativeRuntimeConfig, "binary" | "maxRuntimeMs" | "killGraceMs" | "model">
  > & NativeRuntimeConfig

  constructor(config: NativeRuntimeConfig) {
    this.config = {
      ...config,
      maxRuntimeMs: config.maxRuntimeMs ?? 300_000,
      killGraceMs: config.killGraceMs ?? 5_000,
      model: config.model ?? "native-runtime",
    }
  }

  capabilities(): ModelCapabilities {
    return {
      streaming: this.config.streaming ?? true,
      tools: true,
      thinking: false,
      maxContextTokens: this.config.maxContextTokens ?? 128_000,
      maxOutputTokens: this.config.maxOutputTokens ?? 4_096,
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now()
    try {
      // Check if binary exists and is executable
      const exists = existsSync(this.config.binary)
      return { healthy: exists, latency_ms: Date.now() - start }
    } catch {
      return { healthy: false, latency_ms: Date.now() - start }
    }
  }

  /**
   * Run a completion by spawning the binary, sending the request on stdin,
   * and reading the JSON result from stdout.
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const proc = this.spawnChild()
    const childPid = proc.pid!

    // CRITICAL: Consume stdout/stderr continuously to prevent pipe deadlock
    const stdoutPromise = collectStream(proc.stdout!)
    const stderrPromise = collectStream(proc.stderr!)

    // Send request on stdin
    const requestJson = JSON.stringify(request)
    proc.stdin!.write(requestJson)
    proc.stdin!.end()

    // Timeout: escalated kill
    const timer = setTimeout(() => {
      this.escalateKill(proc, childPid)
    }, this.config.maxRuntimeMs)

    // Wait for exit
    const exitCode = await waitForExit(proc)
    clearTimeout(timer)

    // Verify cleanup
    await verifyGroupEmpty(childPid)

    const stdout = await stdoutPromise
    const stderr = await stderrPromise

    if (exitCode !== 0) {
      throw new Error(
        `NativeRuntime: process exited with code ${exitCode}. stderr: ${stderr.slice(0, 500)}`,
      )
    }

    return this.parseResult(stdout)
  }

  /**
   * Stream a completion by spawning the binary and reading JSONL from stdout.
   * Each line is a StreamChunk in JSON format.
   */
  async *stream(
    request: CompletionRequest,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<StreamChunk> {
    const proc = this.spawnChild()
    const childPid = proc.pid!

    // Consume stderr continuously (prevent deadlock)
    const stderrPromise = collectStream(proc.stderr!)

    // Send request on stdin
    const requestJson = JSON.stringify(request)
    proc.stdin!.write(requestJson)
    proc.stdin!.end()

    // Timeout
    const timer = setTimeout(() => {
      this.escalateKill(proc, childPid)
    }, this.config.maxRuntimeMs)

    // Link AbortSignal to process kill
    const abortHandler = () => {
      this.escalateKill(proc, childPid)
    }
    if (options?.signal) {
      if (options.signal.aborted) {
        this.escalateKill(proc, childPid)
        clearTimeout(timer)
        return
      }
      options.signal.addEventListener("abort", abortHandler, { once: true })
    }

    try {
      // Read stdout line-by-line
      yield* this.readStreamLines(proc.stdout!)
    } finally {
      clearTimeout(timer)
      if (options?.signal) {
        options.signal.removeEventListener("abort", abortHandler)
      }

      // Ensure process is dead
      try { process.kill(-childPid, "SIGKILL") } catch { /* already dead */ }
      await verifyGroupEmpty(childPid)
      await stderrPromise
    }
  }

  // --- Private Methods ---

  private spawnChild(): ChildProcess {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(this.config.env ?? {}),
    }

    const spawnOpts: Parameters<typeof spawn>[2] = {
      detached: true, // setsid — own process group
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.config.cwd,
      env,
    }

    // Only set uid/gid if configured (requires root to change)
    if (this.config.uid !== undefined) {
      (spawnOpts as Record<string, unknown>).uid = this.config.uid
    }
    if (this.config.gid !== undefined) {
      (spawnOpts as Record<string, unknown>).gid = this.config.gid
    }

    const proc = spawn(this.config.binary, this.config.args ?? [], spawnOpts)
    // BB-063-009: Do NOT call proc.unref() here or anywhere.
    // With detached: true, unref() would allow the parent to exit while
    // the child process group is still running, orphaning it before
    // escalateKill can clean up. By keeping the child ref, Node stays
    // alive until the child exits or escalateKill terminates the group.

    if (!proc.pid) {
      throw new Error(`NativeRuntime: failed to spawn ${this.config.binary}`)
    }

    return proc
  }

  private async escalateKill(proc: ChildProcess, childPid: number): Promise<void> {
    // Step 1: SIGTERM to process group
    try { process.kill(-childPid, "SIGTERM") } catch { /* already dead */ }

    // Step 2: Wait grace period for graceful exit
    const exited = await waitForChildExitTimeout(proc, this.config.killGraceMs)

    if (!exited) {
      // Step 3: SIGKILL to process group (cannot be caught)
      try { process.kill(-childPid, "SIGKILL") } catch { /* already dead */ }
    }
  }

  private async *readStreamLines(
    stdout: NodeJS.ReadableStream,
  ): AsyncGenerator<StreamChunk> {
    let buffer = ""

    for await (const chunk of stdout) {
      buffer += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf-8")

      const lines = buffer.split("\n")
      buffer = lines.pop()! // Keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const parsed: NativeOutputLine = JSON.parse(trimmed)
          const streamChunk = this.toStreamChunk(parsed)
          if (streamChunk) yield streamChunk
        } catch {
          // Skip malformed lines (log in production)
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      try {
        const parsed: NativeOutputLine = JSON.parse(buffer.trim())
        const streamChunk = this.toStreamChunk(parsed)
        if (streamChunk) yield streamChunk
      } catch {
        // Skip malformed final line
      }
    }
  }

  private toStreamChunk(line: NativeOutputLine): StreamChunk | null {
    switch (line.event) {
      case "chunk":
        return {
          event: "chunk",
          data: {
            delta: typeof line.data === "string" ? line.data : (line.data as { delta?: string })?.delta ?? "",
            tool_calls: null,
          },
        }
      case "tool_call":
        return { event: "tool_call", data: line.data as StreamChunk extends { event: "tool_call"; data: infer D } ? D : never }
      case "usage":
        return { event: "usage", data: line.data as { prompt_tokens: number; completion_tokens: number; reasoning_tokens: number } }
      case "done":
        return { event: "done", data: { finish_reason: "stop" } }
      case "error":
        return { event: "error", data: { code: "NATIVE_RUNTIME_ERROR", message: String(line.data) } }
      default:
        return null
    }
  }

  private parseResult(stdout: string): CompletionResult {
    // Try to parse as single JSON object (non-streaming mode)
    const trimmed = stdout.trim()
    if (!trimmed) {
      throw new Error("NativeRuntime: empty stdout")
    }

    // Try single JSON result
    try {
      const parsed = JSON.parse(trimmed)
      return {
        content: parsed.content ?? "",
        thinking: parsed.thinking ?? null,
        tool_calls: parsed.tool_calls ?? null,
        usage: parsed.usage ?? { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 },
        metadata: { model: this.config.model, ...parsed.metadata },
      }
    } catch {
      // Fall through to JSONL parsing
    }

    // Parse as JSONL — collect chunks into final result
    const lines = trimmed.split("\n")
    let content = ""
    let usage: UsageInfo = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 }

    for (const line of lines) {
      try {
        const parsed: NativeOutputLine = JSON.parse(line.trim())
        if (parsed.event === "chunk") {
          const data = parsed.data as { delta?: string } | string
          content += typeof data === "string" ? data : data?.delta ?? ""
        } else if (parsed.event === "usage") {
          usage = parsed.data as UsageInfo
        }
      } catch {
        // Skip malformed lines
      }
    }

    return {
      content,
      thinking: null,
      tool_calls: null,
      usage,
      metadata: { model: this.config.model },
    }
  }
}

// --- Shared Helpers ---

/** Continuously consume a readable stream to prevent backpressure deadlock */
function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  return new Promise((resolve) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk))
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
    stream.on("error", () => resolve(""))
  })
}

/** Wait for a child process to exit */
function waitForExit(proc: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    proc.on("exit", (code) => resolve(code ?? 1))
    proc.on("error", reject)
  })
}

/** Wait for exit with timeout. Returns true if exited, false if timed out */
function waitForChildExitTimeout(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    proc.on("exit", () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** Verify no orphans remain in the process group */
async function verifyGroupEmpty(pgid: number): Promise<void> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-g", String(pgid)], {
      timeout: 1000,
    })
    if (stdout.trim()) {
      // Orphans detected — force kill
      try { process.kill(-pgid, "SIGKILL") } catch { /* ignore */ }
    }
  } catch {
    // pgrep not found or no processes — OK
  }
}
