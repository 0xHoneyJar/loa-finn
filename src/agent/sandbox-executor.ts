// src/agent/sandbox-executor.ts — SandboxExecutor strategy pattern (SDD §5.3, Cycle 005)
//
// Three execution modes selected by SANDBOX_MODE env var:
// - worker:        dispatch to WorkerPool (default, non-blocking)
// - child_process: async execFile without workers (rollback, non-blocking)
// - disabled:      fail closed with SANDBOX_DISABLED error
//
// Dev-only sync fallback is handled separately via SANDBOX_SYNC_FALLBACK.

import { execFile } from "node:child_process"
import { PoolError, PoolErrorCode } from "./worker-pool.js"
import type { WorkerPool, ExecSpec, ExecResult } from "./worker-pool.js"

// ── Executor Interface ──────────────────────────────────────

export interface SandboxExecutor {
  exec(spec: ExecSpec): Promise<ExecResult>
}

// ── WorkerExecutor (default) ────────────────────────────────

export class WorkerExecutor implements SandboxExecutor {
  constructor(private readonly pool: WorkerPool) {}

  async exec(spec: ExecSpec): Promise<ExecResult> {
    return this.pool.exec(spec, "interactive")
  }
}

// ── ChildProcessExecutor (rollback) ─────────────────────────

export class ChildProcessExecutor implements SandboxExecutor {
  async exec(spec: ExecSpec): Promise<ExecResult> {
    const start = performance.now()

    return await new Promise<ExecResult>((resolve, reject) => {
      let child: ReturnType<typeof execFile> | undefined

      try {
        child = execFile(
          spec.binaryPath,
          spec.args,
          {
            cwd: spec.cwd,
            env: spec.env,
            maxBuffer: spec.maxBuffer,
            timeout: spec.timeoutMs,
            encoding: "utf-8",
            killSignal: "SIGKILL",
          },
          (err, stdout, stderr) => {
            const durationMs = performance.now() - start

            if (err) {
              const execErr = err as NodeJS.ErrnoException & {
                status?: number | null
                killed?: boolean
                signal?: NodeJS.Signals | null
                code?: string
              }

              let exitCode = execErr.status ?? 1
              // Node sets `killed` for timeout kills; `signal` for other signal terminations
              if (execErr.killed || execErr.signal) exitCode = 137
              const truncated = execErr.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"

              resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode, truncated, durationMs })
              return
            }

            // On success, Node did not hit maxBuffer — only the error path indicates truncation
            resolve({
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              exitCode: child?.exitCode ?? 0,
              truncated: false,
              durationMs,
            })
          },
        )
      } catch (e) {
        // execFile can throw synchronously for invalid arguments/options
        reject(e)
      }

      // Don't keep the event loop alive solely because of this child
      child?.unref()
    })
  }
}

// ── DisabledExecutor (fail closed) ──────────────────────────

export class DisabledExecutor implements SandboxExecutor {
  async exec(_spec: ExecSpec): Promise<ExecResult> {
    throw new PoolError(
      PoolErrorCode.SANDBOX_DISABLED,
      "Sandbox is disabled (SANDBOX_MODE=disabled). Tool execution is not available.",
    )
  }
}

// ── Factory ─────────────────────────────────────────────────

export type SandboxMode = "worker" | "child_process" | "disabled"

export function createExecutor(mode: SandboxMode, pool: WorkerPool): SandboxExecutor {
  switch (mode) {
    case "worker":
      return new WorkerExecutor(pool)
    case "child_process":
      return new ChildProcessExecutor()
    case "disabled":
      return new DisabledExecutor()
    default:
      // Fail closed if callers pass an unexpected value
      throw new PoolError(
        PoolErrorCode.SANDBOX_DISABLED,
        `Invalid SANDBOX_MODE: ${String(mode)}. Tool execution is not available.`,
      )
  }
}
